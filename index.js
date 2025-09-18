const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: "new",
    args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-infobars',
    '--disable-features=site-per-process',
    '--disable-features=IsolateOrigins',
    '--disable-blink-features=AutomationControlled',
    '--disable-translate',
    '--disable-sync',
    '--disable-web-security',
    '--disable-default-apps',
    '--no-zygote',
    '--no-first-run',
    '--mute-audio',
    '--hide-scrollbars',
    '--disable-logging',
    '--disable-notifications'
    ]
  }
});
const FormData = require('form-data');
const cron = require('node-cron');
const Tesseract = require('tesseract.js');
const axios = require('axios');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const readXlsxFile = require('read-excel-file/node');
const path = require('path');
const { publicEncrypt, constants } = require('crypto');
const { URLSearchParams } = require('url');
const cheerio = require('cheerio');
const XLSX = require('xlsx');
const userSessions = new Map();
let cachedSessionCookies = null;
let partnerMappings = null;
const COOKIE_TTL = 360000;        // 6:00 min
const REFRESH_THRESHOLD = 288000; // 4:48 min
let lastAuthTime = 0;
let refreshingPromise = null;
let autoRefreshTimeout = null;
let partnerIndex = null;
let subscriberDataCache = null;

const toTitleCase = (str) => {
    if (!str) return '';
    return str.trim()
              .split(/\s+/)
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
};

const normalize = (str) => str?.toString().trim().toLowerCase() || '';

const maskName = (name) => {
    if (!name || typeof name !== 'string') return 'N/A';
    const parts = name.trim().split(/\s+/);
    const maskedParts = parts.map(part => {
        if (part.length <= 3) {
            return part; // Don't mask short words
        }
        // Keeps first 3 letters, masks the rest with 'x'
        return part.substring(0, 3) + 'x'.repeat(part.length - 3);
    });
    return maskedParts.join(' ');
};

const maskUsername = (userCode) => {
    if (!userCode || typeof userCode !== 'string') return 'N/A';

    // Handles usernames like "jh.jgn.amanmishra" -> "jh.jgn.amaxxxxxxx"
    const parts = userCode.split('.');
    if (parts.length >= 3) {
        const namePart = parts[parts.length - 1];
        if (namePart.length > 3) {
            const maskedNamePart = namePart.substring(0, 3) + 'x'.repeat(namePart.length - 3);
            parts[parts.length - 1] = maskedNamePart;
        }
        return parts.join('.');
    }

    // Handles subscriber IDs like "12345" -> "123xx" for consistency
    if (/^\d{5,}$/.test(userCode)) {
        if (userCode.length <= 3) return userCode;
        return userCode.substring(0, 3) + 'x'.repeat(userCode.length - 3);
    }

    return userCode; // Return as is if it doesn't match
};

const createHeaderMap = (header) => header.reduce((acc, col, index) => {
    acc[col] = index;
    return acc;
}, {});



const loadAllData = async () => {
    try {
        await Promise.all([
            loadUserDataFromExcel(),
            loadExcelData(),
            loadPartnerMappings(),
            loadSubscriberData()
        ]);
    } catch (err) {
        console.error('Error loading data:', err.message);
    }
};

const userDataCacheByFile = {};

const loadUserDataFromExcel = async (filename = 'PortalUsers.xlsx') => {
    if (userDataCacheByFile[filename]) return userDataCacheByFile[filename];

    try {
        const filePath = path.resolve(__dirname, filename);
        const rows = await readXlsxFile(filePath);
        if (!rows || rows.length < 2) return new Map();

        const [header, ...data] = rows;
        const headerMap = createHeaderMap(header);


        const idxUsername = headerMap['Username'];
        const idxName = headerMap['Name'];
        const idxMobileNo = headerMap['MobileNo'];
        const idxSubscriberId = headerMap['SubscriberId'];
        const idxEmail = headerMap['Email'];

        const userDataCache = new Map();

        for (let i = 0, len = data.length; i < len; i++) {
            const row = data[i];
            const username = normalize(row[idxUsername]);
            const name = normalize(row[idxName]);
            const mobileNo = normalize(row[idxMobileNo]);
            const subscriberId = normalize(row[idxSubscriberId]);
            const email = normalize(row[idxEmail]);

            const userData = {
                MobileNo: mobileNo,
                Username: username,
                SubscriberId: subscriberId,
                Name: name,
                Email: email
            };

            if (username) userDataCache.set(username, userData);
            if (subscriberId) userDataCache.set(subscriberId, userData);
        }

        userDataCacheByFile[filename] = userDataCache;
        return userDataCache;
    } catch (err) {
        console.error(`Error loading user data from Excel: ${err.message}`);
        return new Map();
    }
};

const loadPartnerMappings = (filename = 'TicketMappingANP.xlsx') => {
    if (partnerMappings) return partnerMappings;

    try {
        const workbook = XLSX.readFile(path.join(__dirname, filename));
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        
        partnerMappings = {};
        
        for (const row of rows) {
            const jhCode = row['JH Code']?.trim();
            const partnerId = row['Partner ID']?.toString().trim();
            
            if (jhCode && partnerId) {
                partnerMappings[jhCode] = {
                    partnerId: partnerId,
                    partnerName: row['Partner Name']?.trim() || 'Unknown'
                };
            }
        }
        return partnerMappings;
    } catch (err) {
        console.error(`Error reading partner mappings: ${err.message}`);
        return {};
    }
};

const getSubscriberCount = async () => {
    try {
        const cookies = await getCookies();
        if (!cookies) {
            throw new Error("Authentication failed, cannot get cookies.");
        }

        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        
        // The dashboard URL is /billcntl
        const dashboardUrl = 'https://jh.railwire.co.in/billcntl';

        const response = await axios.get(dashboardUrl, {
            headers: { 'Cookie': cookieString }
        });

        const $ = cheerio.load(response.data);

        // Find the div with the text 'active subscribers', then get the number from the sibling span
        const subscriberCount = $('.infobox-content:contains("active subscribers")')
                                  .siblings('.infobox-data-number')
                                  .text()
                                  .trim();

        if (subscriberCount) {
            return subscriberCount;
        } else {
            return 'Count not found.';
        }

    } catch (error) {
        console.error('Error fetching subscriber count:', error.message);
        return 'Could not retrieve count.';
    }
};

const loadExcelData = () => {
    if (jhCodeMap) return;

    try {
        const workbook = XLSX.readFile(path.join(__dirname, 'CAFMappingANP.xlsx'));
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        jhCodeMap = new Map();
        partnerIndex = new Map();
        
        for (const row of data) {
            const partner = normalize(row['Associated Partner']);
            const jhCode = row['JH Code'];
            
            if (partner && jhCode) {
                jhCodeMap.set(partner, jhCode);
                
                const words = partner.split(' ');
                for (const word of words) {
                    if (word.length > 2) {
                        if (!partnerIndex.has(word)) {
                            partnerIndex.set(word, new Set());
                        }
                        partnerIndex.get(word).add(partner);
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Error reading Excel file: ${err.message}`);
    }
};

const scheduleAutoRefresh = () => {
  if (autoRefreshTimeout) clearTimeout(autoRefreshTimeout);
  const timeSinceAuth = Date.now() - lastAuthTime;
  const delay = Math.max(REFRESH_THRESHOLD - timeSinceAuth, 0);

  autoRefreshTimeout = setTimeout(() => {
    if (!refreshingPromise) {
      refreshingPromise = refreshCookies();
    }
  }, delay);
};

const refreshCookies = async () => {
    try {
        const { railwireCookie, ciSessionCookie } = await authenticate('admin', 'Pass@123');
        cachedSessionCookies = { railwireCookie, ciSessionCookie };
        lastAuthTime = Date.now();
        scheduleAutoRefresh();
        return cachedSessionCookies;
    } catch (err) {
        console.error('Cookie refresh failed:', err.message);
        return null;
    } finally {
        refreshingPromise = null;
    }
};

// NEW FEATURE: Handles interactive subscriber detail updates
const handleSubscriberUpdate = async (message) => {
    const chat = await message.getChat();

    try {
        // 1. Ask for Username or Subscriber ID
        await chat.sendMessage("Enter Username or ID:");
        const idMessage = await waitForReply(message);
        const userCode = idMessage.body.trim();
        if (!userCode) {
            await chat.sendMessage("❌ Canceled. No ID provided.");
            return;
        }

        // 2. Fetch user data (Excel first, then live portal as a fallback)
        const userDataMap = await loadUserDataFromExcel(); // Load the local Excel cache
        const userData = userDataMap.get(normalize(userCode)) || await fetchUserDataFromPortal(userCode);

        // 3. Validate if user was found
        if (!userData || !userData.SubscriberId) {
            await chat.sendMessage(`❌ Could not find a subscriber with the ID "${userCode}". Please check and try again.`);
            return;
        }

        // 4. Ask for the new Phone Number
        await chat.sendMessage(`Found: *${userData.Username}*\n\nEnter the new Phone Number:`);
        const phoneMessage = await waitForReply(message);
        const newPhoneNumber = phoneMessage.body.trim();
        if (!/^\d{10}$/.test(newPhoneNumber)) {
            await chat.sendMessage("❌ Invalid phone number. Please enter a 10-digit number. Operation canceled.");
            return;
        }

        // 5. Ask for the new Email Address
        await chat.sendMessage(`Enter the new Email Address:`);
        const emailMessage = await waitForReply(message);
        const newEmail = emailMessage.body.trim().toLowerCase();
        if (!/\S+@\S+\.\S+/.test(newEmail)) {
            await chat.sendMessage("❌ Invalid email format. Operation canceled.");
            return;
        }
        
        // 6. Perform the update via API call
        const cookies = await getCookies();
        if (!cookies) {
            await chat.sendMessage("❌ Authentication failed. Cannot proceed.");
            return;
        }

        const payload = new URLSearchParams({
            'cnumber': newPhoneNumber,
            'cemail': newEmail,
            'id': userData.SubscriberId,
            'railwire_test_name': cookies.railwireCookie.value
        });

        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        };

        const response = await axios.post('https://jh.railwire.co.in/billcntl/resetsdetail', payload.toString(), config);

        // 7. Confirm the result to the user
        if (response.data && response.data.STATUS === "OK") {
            await chat.sendMessage(`✅ Details have been updated successfully for *${userData.Username}*!`);
        } else {
            const serverStatus = response.data ? response.data.STATUS : "No response";
            await chat.sendMessage(`❌ Update failed. Server responded: ${serverStatus}`);
        }

    } catch (error) {
        console.error("Error during subscriber update:", error.message);
        await chat.sendMessage("❌ An unexpected error occurred during the update process.");
    }
};


const getCookies = async () => {
    const now = Date.now();
    const age = now - lastAuthTime;

    if (cachedSessionCookies && age < COOKIE_TTL) {
        return cachedSessionCookies;
    }

    if (!refreshingPromise) {
        refreshingPromise = refreshCookies().catch(err => {
            console.error('Error during refreshCookies():', err.message);
            return null;
        });
    }

    return refreshingPromise;
};



const baseURL = 'https://jh.railwire.co.in';
const mainURL = `${baseURL}/billcntl/kycpending`;
let jhCodeMap = null;

const generateQRCode = (qr) => {
    console.log('Scan the QR code below to login:');
    qrcode.generate(qr, { small: true });
};


const authenticate = async (username, password) => {
    return retryOperation(async () => {
        let sessionCookies = {};

        // Helper function to parse and store cookies from server responses
        function updateAndGetCookieHeader(response) {
            const setCookieHeader = response.headers['set-cookie'];
            if (setCookieHeader) {
                setCookieHeader.forEach(cookieString => {
                    const [cookiePair] = cookieString.split(';');
                    const [key, ...valueParts] = cookiePair.split('=');
                    if (key && valueParts.length > 0) {
                        sessionCookies[key.trim()] = valueParts.join('=').trim();
                    }
                });
            }
            return Object.entries(sessionCookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }

        try {
            // Step 1: Get initial cookies and tokens from the login page
            const loginPageResponse = await axios.get(`${baseURL}/rlogin`, { timeout: 30000 });
            let currentCookieHeader = updateAndGetCookieHeader(loginPageResponse);
            const pageHtml = loginPageResponse.data;
            const $ = cheerio.load(pageHtml);

            const railwireTestToken = $('input[name="railwire_test_name"]').val();
            const dynamicSaltToken = (pageHtml.match(/var salt = '([^']+)';/) || [])[1];

            if (!railwireTestToken || !dynamicSaltToken) {
                throw new Error('Failed to extract tokens from login page.');
            }

            // Step 2: Download and solve the CAPTCHA image
            const captchaImageUrl = $('#captcha_code').attr('src');
            const captchaImageBuffer = (await axios.get(`${baseURL}${captchaImageUrl}`, {
                responseType: 'arraybuffer',
                headers: { 'Cookie': currentCookieHeader }
            })).data;
            const { data: { text } } = await Tesseract.recognize(captchaImageBuffer, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            });
            const captchaText = text.replace(/[^A-Z0-9]/g, '');
            if (!captchaText) {
                throw new Error('Failed to solve CAPTCHA using Tesseract.');
            }

            // Step 3: Get the public key for password encryption
            const publicKeyResponse = await axios.get(`${baseURL}/rlogin/getPublicKey?token=${dynamicSaltToken}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Cookie': currentCookieHeader }
            });
            const publicKey = publicKeyResponse.data.publicKey;
            if (!publicKey) {
                throw new Error('Failed to retrieve public key.');
            }

            // Step 4: Encrypt the password using the public key and salt
            const encryptedPasswordBase64 = publicEncrypt(
                { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
                Buffer.from(`${password}::${dynamicSaltToken}`)
            ).toString('base64');

            // Step 5: Prepare and send the final login request
            const loginFormData = new URLSearchParams({
                railwire_test_name: railwireTestToken,
                username: username, // Use username from function argument
                password: encryptedPasswordBase64,
                code: captchaText,
                baseurl: '',
            });

            const loginResponse = await axios.post(`${baseURL}/rlogin`, loginFormData.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': currentCookieHeader },
                maxRedirects: 0,
                validateStatus: status => status === 303, // A 303 redirect means success
            });

            // Step 6: Capture the final session cookies and format the return value
            updateAndGetCookieHeader(loginResponse);

            if (loginResponse.status === 303) {
                console.log('Login successful!');

                const railwireCookieValue = sessionCookies['railwire_cookie_name'];
                const ciSessionValue = sessionCookies['ci_session'];

                if (!railwireCookieValue || !ciSessionValue) {
                    throw new Error('Required cookies not found after successful login.');
                }
                
                // Return cookies in the format expected by the rest of the code
                return {
                    railwireCookie: { name: 'railwire_cookie_name', value: railwireCookieValue },
                    ciSessionCookie: { name: 'ci_session', value: ciSessionValue }
                };
            } else {
                throw new Error('Login failed. Server did not return a 303 redirect.');
            }
        } catch (error) {
            console.error('Authentication attempt failed:', error.message);
            throw error; // Re-throw to allow the retryOperation to work
        }
    });
};

async function retryOperation(operation, maxRetries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}


async function fetchUserDataFromPortal(userCode) {
  const cookies = await getCookies();

  const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
  const payload = new URLSearchParams({
    'railwire_test_name': cookies.railwireCookie.value,
    'user-search': userCode
  });

  const searchResponse = await axios.post(
    'https://jh.railwire.co.in/billcntl/searchsub ',
    payload.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    }
  );

  let finalUrl = searchResponse.headers.location;
  if (!finalUrl.startsWith('http')) {
    finalUrl = `https://jh.railwire.co.in${finalUrl}`;
  }

  const tableResponse = await axios.get(finalUrl, {
    headers: { Cookie: cookieString }
  });

  const $ = cheerio.load(tableResponse.data);
  const row = $('table.table-striped tbody tr').first();
  if (!row.length) return null;

  const cells = row.find('td');
  if (cells.length < 6) return null;

  const usernameAnchor = cells.eq(1).find('a');
  const userDetailHref = usernameAnchor.attr('href');
  const userDetailUrl = `https://jh.railwire.co.in${userDetailHref}`;

  let name = '';
  try {
    const detailResponse = await axios.get(userDetailUrl, {
      headers: { Cookie: cookieString }
    });

    const $$ = cheerio.load(detailResponse.data);
    $$('.table-bordered.table-condensed.table-striped tr').each((_, tr) => {
      const key = $$(tr).find('td').first().text().trim();
      if (key === 'Name') {
        name = $$(tr).find('td').eq(1).text().trim();
      }
    });
  } catch (err) {
    console.error('Failed to fetch user detail page:', err.message);
  }

  const userData = {
    username: usernameAnchor.text().trim(),
    mobileNo: cells.eq(5).text().trim(),
    id: cells.eq(0).text().trim(),
    name: name
  };

  return userData ? {
    Username: userData.username,
    MobileNo: userData.mobileNo,
    SubscriberId: userData.id,
    Name: userData.name
  } : null;
}

const resetSession = async (userData, cookies) => {
    const payload = `uname=${userData.Username}&railwire_test_name=${cookies.railwireCookie.value}`;
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };
    try {
        // Only make the single, necessary API call
        const response = await axios.post('https://jh.railwire.co.in/billcntl/endacctsession', payload, config);
        
        console.log(`Session reset response:`, response.data);

        // First, check if the message indicates the session was not active.
        if (response.data.message && response.data.message.includes('-1')) {
            return 'NOT_ACTIVE';
        } 
        // If not, then check if the status is OK for a true success.
        else if (response.data.STATUS === 'OK') {
            return 'SUCCESS';
        } 
        // Anything else is an error.
        else {
            return 'ERROR';
        }
    } catch (error) {
        console.error('Reset error:', error.message);
        return 'ERROR';
    }
};

const DeactivateID = async (userData, cookies) => {
    const payload = `subid=${userData.SubscriberId}&railwire_test_name=${cookies.railwireCookie.value}`;
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };

    try {
        const response = await axios.post('https://jh.railwire.co.in/billcntl/update_expiry', payload, config);
        
        console.log(`ID status: ${response.data.STATUS}`);
        return response.data.STATUS === 'OK';
    } catch (error) {
        console.error('Deactivate error:', error.message);
        return false;
    }
};

const resetPassword = async (userData, cookies) => {
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };

    const basePayload = `subid=${userData.SubscriberId}&mobileno=${userData.MobileNo}&railwire_test_name=${cookies.railwireCookie.value}`;

    try {
        const [portalRes, pppoeRes] = await Promise.all([
            axios.post('https://jh.railwire.co.in/subapis/subpassreset', `${basePayload}&flag=Bill`, config),
            axios.post('https://jh.railwire.co.in/subapis/subpassreset', `${basePayload}&flag=Internet`, config)
        ]);
        
        console.log(`Portal: ${portalRes.data.STATUS} | PPPoE: ${pppoeRes.data.STATUS}`);
        return { 
            portalReset: portalRes.data.STATUS === 'OK', 
            pppoeReset: pppoeRes.data.STATUS === 'OK' 
        };
    } catch (error) {
        console.error('Password reset error:', error.message);
        return { portalReset: false, pppoeReset: false };
    }
};


const getUserIdentifier = (message) => {
    return message.fromMe ? message.to : (message.author || message.from);
};

const waitForReply = async (originalMessage) => {
    const userIdentifier = getUserIdentifier(originalMessage);
    return new Promise((resolve) => {
        const listener = (message) => {
            if (getUserIdentifier(message) === userIdentifier) {
                client.removeListener('message', listener);
                resolve(message);
            }
        };
        client.on('message', listener);
    });
};

const handlePlanChange = async (message) => {
    const chat = await message.getChat();
    const messageBody = message.body; // Use original case for usernames

    // 1. Define patterns for usernames, subscriber IDs (for checking), and package IDs
    const usernamePattern = /jh[\.\w]+/gi;
    const subscriberIdPattern = /\b\d{5,}\b/g; // To detect if user sent a subscriber ID
    const packageIdPattern = /\b\d{3,6}\b/g;   // Package IDs can be 3 to 6 digits

    // 2. Extract all potential matches
    const usernames = messageBody.match(usernamePattern) || [];
    const subscriberIds = messageBody.match(subscriberIdPattern) || [];
    const potentialPackageIds = messageBody.match(packageIdPattern) || [];

    // 3. Validate the input with clear rules
    if (usernames.length === 0 && subscriberIds.length > 0) {
        return await chat.sendMessage("❌ Please provide a username not a subscriber ID.");
    }
    if (usernames.length === 0) {
        return await chat.sendMessage("❌ Username not found in the message. send like this: planchange jh.xyz.username 800829");
    }
    if (potentialPackageIds.length === 0) {
        return await chat.sendMessage("❌ Please provide a 3 to 6-digit Package ID in your message.");
    }
    if (potentialPackageIds.length > 1) {
        return await chat.sendMessage("❌ Please provide only one Package ID at a time to apply to all users.");
    }

    const desiredPkgId = potentialPackageIds[0];
    await chat.sendMessage(`⏳ Processing plan change for ${usernames.length} user(s) to Package ID: *${desiredPkgId}*...`);

    const cookies = await getCookies();
    if (!cookies) {
        return await chat.sendMessage("Authentication failed. Cannot proceed with plan change.");
    }
    const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;

    // 4. Loop through each VALIDATED username and process the plan change
    for (const username of usernames) {
        try {
            const payload = new URLSearchParams({
                'railwire_test_name': cookies.railwireCookie.value,
                'user-search': username
            });

            const searchResponse = await axios.post(
                'https://jh.railwire.co.in/billcntl/searchsub ',
                payload.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded', 
                        'Cookie': cookieString 
                    },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400
                }
            );

            const finalUrl = `https://jh.railwire.co.in${searchResponse.headers.location}`;
            const tableResponse = await axios.get(finalUrl, { headers: { 'Cookie': cookieString } });
            const $ = cheerio.load(tableResponse.data);

            const searchResults = [];
            $('table.table-striped tbody tr').each(function() {
                const row = $(this);
                const foundUsername = row.find('td:nth-child(2) a').text().trim();
                const link = row.find('td:nth-child(2) a').attr('href');
                if (foundUsername && link) {
                    searchResults.push({ username: foundUsername, link });
                }
            });

            if (searchResults.length === 0) {
                await chat.sendMessage(`❌ No user found for "${username}". Skipping.`);
                continue;
            }

            const selectedUser = searchResults.find(user => user.username.toLowerCase() === username.toLowerCase());

            if (!selectedUser) {
                await chat.sendMessage(`❌ No exact match found for "${username}". Found ${searchResults.length} partial matches. Skipping.`);
                continue;
            }

            const detailUrl = `https://jh.railwire.co.in${selectedUser.link}`;
            const detailPage = await axios.get(detailUrl, { headers: { 'Cookie': cookieString } });

            const $$ = cheerio.load(detailPage.data);
            const formData = {
                subid: $$('#subid').val() || '',
                status: $$('#status').val() || '',
                oldpkgid: $$('#oldpackageid').val() || '',
                verifyHidden: $$('#verifyHidden').val() || '',
                pkgid: desiredPkgId
            };

            const planChanged = await ChangePlan(formData, selectedUser.username, cookies);

            if (planChanged) {
                await chat.sendMessage(`✅ Plan changed successfully for *${selectedUser.username}* to Package ID *${desiredPkgId}*!`);
            } else {
                await chat.sendMessage(`❌ Failed to change plan for *${selectedUser.username}*. Check package ID and try again.`);
            }

        } catch (error) {
            console.error(`Error processing plan change for ${username}:`, error.message);
            await chat.sendMessage(`❌ An error occurred while processing plan change for *${username}*.`);
        }
    }
};

const handleSubscriberSearch = async (message, searchTerm) => {
    const chat = await message.getChat();

    if (!searchTerm) {
        await chat.sendMessage("Search term cannot be empty. Please try again by typing `search <username>`.");
        return;
    }

    // Check if the data cache is loaded and ready
    if (!subscriberDataCache || subscriberDataCache.size === 0) {
         await chat.sendMessage("Subscriber data is not loaded or is empty. Please check the server logs.");
         console.error("Attempted to search before subscriberDataCache was loaded or the file is empty.");
         return;
    }

    // Normalize the search term and look it up in the cache
    const normalizedTerm = normalize(searchTerm);
    const result = subscriberDataCache.get(normalizedTerm);

    if (result) {
        // If a match is found, format the details into a reply
        let reply = `*Subscriber Details*\n\n`;
        reply += `*Subscriber ID:* ${result['Subscriber ID'] || 'N/A'}\n`;
        reply += `*Username:* ${result['Username'] || 'N/A'}\n`;
        reply += `*ANP ID:* ${result['ANP ID'] || 'N/A'}\n`;
        reply += `*ANP Name:* ${result['ANP Name'] || 'N/A'}\n`;
        reply += `*District:* ${result['District'] || 'N/A'}\n`;
        reply += `*Stack VLAN:* ${result['Stack VLAN'] || 'N/A'}\n`;
        reply += `*Customer VLAN:* ${result['Customer VLAN'] || 'N/A'}\n`;
        reply += `*JH Code:* ${result['JH Code'] || 'N/A'}\n`;
        reply += `*Subscriber Count:* ${result['Subscriber Count'] || 'N/A'}\n`;
        reply += `*Primary Port:* ${result['Port'] || 'N/A'}\n`;
        reply += `*Backup Port:* ${result['Backup Port'] || 'N/A'}\n`;
        reply += `*BNG:* ${result['BNG'] || 'N/A'}\n`;
        reply += `*Marketing Team:* ${result['Marketing Team'] || 'N/A'}\n`;
        reply += `*Marketing Team No.:* ${result['Marketing Team No.'] || 'N/A'}\n`;

        await chat.sendMessage(reply);
    } else {
        // If no match is found, inform the user
        await chat.sendMessage(`❌ No subscriber found for "${searchTerm}".`);
    }
};

async function login() {
  try {
    const response = await axios.post('http://apiv1.inteligo.tech/api/OTT/GSignin', {
      UserName: 'JH-MSP',
      Platform: 'GPanel',
      Password: 'WfGMAkmJtRundSrD7r/MQA==',
      IPAddress: ''
    });

    return response.data; // Should contain UserId
  } catch (error) {
    console.error('Login failed:', error.message);
    throw error;
  }
}


const checkComplaintStatus = async (message) => {
    const chat = await message.getChat();

    // Step 1: Ask for Complaint Number
    await chat.sendMessage("🔢 Complaint No:");
    const compNoMsg = await waitForReply(message);
    const complaintNumber = parseInt(compNoMsg.body.trim());

    if (isNaN(complaintNumber)) {
        await chat.sendMessage("❌ Invalid Complaint Number.");
        return;
    }

    // Step 2: Login to get UserId
    let loginResult;
    try {
        loginResult = await login();
    } catch (err) {
        await chat.sendMessage("❌ Failed to authenticate with backend.");
        return;
    }

    // Step 3: Fetch all complaints
    try {
        const complaintsResponse = await axios.post(
            `http://apiv1.inteligo.tech/api/OTT/GGetOTTComplaintList?UserID=${loginResult.UserId}`,
            loginResult.UserId
        );

        const complaints = complaintsResponse.data;

        // Step 4: Find the complaint
        const complaint = complaints.find(c => c.ComplaintNumber === complaintNumber);

        if (!complaint) {
            await chat.sendMessage(`❌ No complaint found with number ${complaintNumber}`);
            return;
        }

        // Step 5: Format and send response in your desired format
        const statusMap = {
            'Closed': '✅',
            'OnHold': '⏸️',
            'Open': '🔄'
        };

        const statusEmoji = statusMap[complaint.Status] || 'ℹ️';
        const remark = complaint.Remark ? complaint.Remark : "No remarks provided.";

        let reply = "*Complaint Status*\n\n";
        reply += `*Complaint Number:* ${complaint.ComplaintNumber}\n`;
        reply += `*Username:* ${complaint.Username}\n`;
        reply += `*Status:* ${statusEmoji} ${complaint.Status}\n`;
        reply += `*Service:* ${complaint.ServiceProvider}\n\n`;
        reply += `*Remark:* ${remark}`;

        await chat.sendMessage(reply);

    } catch (error) {
        await chat.sendMessage(`❌ Error fetching complaint.\n\nError: ${error.message}`);
    }
};


const handleAnpUpdate = async (message) => {
    const chat = await message.getChat();

    try {
        // Part 1 & 2: Find the ANP and gather new info (This part is correct and unchanged)
        await chat.sendMessage("Enter Partner Name or ID:");
        const searchTerm = (await waitForReply(message)).body.trim();
        if (!searchTerm) {
            await chat.sendMessage("❌ Canceled. No search term provided.");
            return;
        }

        const cookies = await getCookies();
        if (!cookies) {
            await chat.sendMessage("❌ Authentication failed. Cannot search.");
            return;
        }
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        const listUrl = `${baseURL}/billcntl/billpartners`;
        
        const listResponse = await axios.get(listUrl, { headers: { 'Cookie': cookieString } });
        const $ = cheerio.load(listResponse.data);

        let match = null;
        let multipleMatches = [];
        const normalizedSearch = normalize(searchTerm);

        $('table#dynamic-table tbody tr').each(function() {
            const row = $(this);
            const partnerId = normalize(row.find('td').eq(0).text());
            const companyName = normalize(row.find('td').eq(1).find('a').text());
            
            if (partnerId === normalizedSearch || companyName === normalizedSearch) {
                const foundMatch = {
                    name: row.find('td').eq(1).find('a').text().trim(),
                    id: row.find('td').eq(0).text().trim(),
                    link: row.find('td').eq(1).find('a').attr('href')
                };
                multipleMatches.push(foundMatch);
            }
        });

        if (multipleMatches.length === 0) {
            await chat.sendMessage(`❌ No ANP found matching "${searchTerm}".`);
            return;
        } else if (multipleMatches.length > 1) {
            await chat.sendMessage(`❌ Found multiple ANPs. Please be more specific:\n- ${multipleMatches.map(m => m.name).join('\n- ')}`);
            return;
        } else {
            match = multipleMatches[0];
        }

        await chat.sendMessage(`Found ANP: *${match.name}*\n\nInput New Mobile No.:`);
        const phoneMessage = await waitForReply(message);
        const newPhoneNumber = phoneMessage.body.trim();
        if (!/^\d{10}$/.test(newPhoneNumber)) {
            await chat.sendMessage("❌ Invalid phone number. Operation canceled.");
            return;
        }

        await chat.sendMessage(`Input New Email ID:`);
        const emailMessage = await waitForReply(message);
        const newEmail = emailMessage.body.trim().toLowerCase();
        if (!/\S+@\S+\.\S+/.test(newEmail)) {
            await chat.sendMessage("❌ Invalid email format. Operation canceled.");
            return;
        }
        
        await chat.sendMessage(`Everything correct? (yes/no)`);
        const bankReply = await waitForReply(message);
        const updateBankDetails = bankReply.body.trim().toLowerCase() === 'yes';

        // Part 3: Scrape detail page (This part is correct and unchanged)
        const detailUrl = baseURL + match.link;
        const detailResponse = await axios.get(detailUrl, { headers: { 'Cookie': cookieString } });
        const $$ = cheerio.load(detailResponse.data);

        const scrapeValue = (label) => $$('.profile-info-name:contains("' + label + '")').next().find('span.editable').text().trim();
        const scrapeHidden = (id) => $$(`#${id}`).val()?.trim() || '';
        const scrapeHtml = (id) => $$(`#${id}`).html()?.trim() || '';

        let gstin_raw = ($$('.profile-info-name:contains("GSTIN No")').next().text().trim() || scrapeHidden("gstinval")).trim();
        let gstin = (gstin_raw.startsWith('undefined') || gstin_raw === "") ? " " : gstin_raw;
        
        const payload = {
            'railwire_test_name': cookies.railwireCookie.value, 'partnerid': scrapeHidden('partnerid'), 'cname': scrapeValue("Company Name"), 'cregno': scrapeValue("Company Registration Number"),
            'caddress': scrapeHtml('caddress'), 'cmanager': scrapeValue("Contact Person"), 'cnumber': newPhoneNumber, 'cemail': newEmail, 'agreementdate': scrapeValue("Railwire Agreement Date"),
            'agreementno': scrapeValue("Railwire Agreement No"), 'pancard': scrapeHidden('pancard'), 'bank_acholder': scrapeValue("Bank Account Holder Name"), 'bank_actype': scrapeValue("Bank Account Type"),
            'bank_name': scrapeHtml('bank_name'), 'bank_branch': scrapeHtml('bank_branch'), 'bank_acno': scrapeValue("Bank Account No"), 'bank_ifsc': scrapeHidden('bank_ifsc'), 'gstin': gstin,
            'sacno': scrapeValue("SAC No"), 'ptype': scrapeHtml('ptype'), 'gst_status': scrapeHidden("gststatus1"), 'legalname': scrapeHidden("legalnameval"), 'tradename': scrapeHidden("tradenameval"),
            'ptnrattid': scrapeHtml('ptnrattid'), 'ptnrlang': scrapeHtml('ptnrlang'), 'territory_name': scrapeHidden('territory_name'), 'ring': scrapeValue("Ring"), 'brasip': scrapeValue("BRAS IP"),
            'switchip': scrapeValue("Switch IP"), 'dropping': scrapeValue("Dropping"), 'interface': scrapeValue("Interface"), 'port_number': scrapeValue("Port Number"), 'pop_name': scrapeValue("Pop Name"),
            'pop_pincode': scrapeValue("Pop Pin Code"), 'ngcomany': scrapeHidden('ngcomany'), 'brmobile': updateBankDetails ? newPhoneNumber : scrapeValue("Bank Registered Mobile No"),
            'bremail': updateBankDetails ? newEmail : scrapeValue("Bank Registered Email ID"), 'reject_remark': "", 'onlinesub': "0", 'taxpayertype': 0, 'loc_type': null,
            'onrechargeatom': 0, 'bankcheck': '1', 'subonrechargerazorpay': 0
        };

        // --- Part 4: Display ALL data for confirmation, just like the JS snippet ---
        let confirmationMessage = `*Confirm Details*\n_Changes are highlighted in bold._\n\n`;
        confirmationMessage += `*Partner ID:* ${payload.partnerid}\n`;
        confirmationMessage += `*Company Name:* ${payload.cname}\n`;
        confirmationMessage += `*Nature of Co:* ${payload.ngcomany}\n`;
        confirmationMessage += `*Company Reg No:* ${payload.cregno}\n`;
        confirmationMessage += `*Address:* ${payload.caddress}\n`;
        confirmationMessage += `*Contact Person:* ${payload.cmanager}\n`;
        confirmationMessage += `*Phone:* *${payload.cnumber}*\n`;
        confirmationMessage += `*Email Address:* *${payload.cemail}*\n`;
        confirmationMessage += `*PAN Card:* ${payload.pancard}\n`;
        confirmationMessage += `*Agreement Date:* ${payload.agreementdate}\n`;
        confirmationMessage += `*Agreement No:* ${payload.agreementno}\n`;
        confirmationMessage += `*Partner Type:* ${payload.ptype}\n`;
        confirmationMessage += `*Territory:* ${payload.territory_name}\n\n`;
        confirmationMessage += `--- *GST Details* ---\n`;
        confirmationMessage += `*GSTIN:* ${payload.gstin}\n`;
        confirmationMessage += `*GST Legal Name:* ${payload.legalname}\n`;
        confirmationMessage += `*GST Trade Name:* ${payload.tradename}\n`;
        confirmationMessage += `*GST Status:* ${payload.gst_status}\n`;
        confirmationMessage += `*SAC No:* ${payload.sacno}\n\n`;
        confirmationMessage += `--- *Bank Details* ---\n`;
        confirmationMessage += `*Bank Holder:* ${payload.bank_acholder}\n`;
        confirmationMessage += `*Bank Acct Type:* ${payload.bank_actype}\n`;
        confirmationMessage += `*Bank Name:* ${payload.bank_name}\n`;
        confirmationMessage += `*Bank Branch:* ${payload.bank_branch}\n`;
        confirmationMessage += `*Bank Acct No:* ${payload.bank_acno}\n`;
        confirmationMessage += `*Bank IFSC:* ${payload.bank_ifsc}\n`;
        confirmationMessage += `*Bank Mobile:* ${updateBankDetails ? `*${payload.brmobile}*` : payload.brmobile}\n`;
        confirmationMessage += `*Bank Email:* ${updateBankDetails ? `*${payload.bremail}*` : payload.bremail}\n\n`;
        confirmationMessage += `--- *Technical Details* ---\n`;
        confirmationMessage += `*Ring:* ${payload.ring}\n`;
        confirmationMessage += `*BRAS IP:* ${payload.brasip}\n`;
        confirmationMessage += `*Switch IP:* ${payload.switchip}\n`;
        confirmationMessage += `*Dropping:* ${payload.dropping}\n`;
        confirmationMessage += `*Interface:* ${payload.interface}\n`;
        confirmationMessage += `*Port Number:* ${payload.port_number}\n`;
        confirmationMessage += `*POP Name:* ${payload.pop_name}\n`;
        confirmationMessage += `*POP Pincode:* ${payload.pop_pincode}\n`;

        await chat.sendMessage(confirmationMessage);
        await chat.sendMessage("Correct? Type *yes* to submit, or anything else to cancel.");
        const finalConfirmation = await waitForReply(message);

        // --- Part 5: Final Submission (This part is correct and unchanged) ---
        if (finalConfirmation.body.trim().toLowerCase() === 'yes') {
            const updateUrl = `${baseURL}/billcntl/savepdetailbefore`;
            const updateResponse = await axios.post(updateUrl, new URLSearchParams(payload), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieString }
            });

            if (updateResponse.data && (updateResponse.data.STATUS === "OK" || updateResponse.data.STATUS === "BANK VERIFIED")) {
                await chat.sendMessage(`✅ ANP details updated successfully for *${match.name}*!`);
            } else {
                const errorMsg = updateResponse.data ? (updateResponse.data.MESSAGE || updateResponse.data.STATUS) : "Unknown error";
                await chat.sendMessage(`❌ Update failed for *${match.name}*. Server response: ${errorMsg}`);
            }
        } else {
            await chat.sendMessage("❌ Update canceled by user. No changes were made.");
            return;
        }

    } catch (error) {
        console.error("Error during ANP update:", error.message);
        await chat.sendMessage("❌ An unexpected error occurred during the ANP update process.");
    }
};

// New function to handle OTT complaints automatically
const processOTTComplaint = async (message, userIdentifier, serviceProvider) => {
    const { userCode } = userSessions.get(userIdentifier);
    const chat = await message.getChat();
    
    // Load OTT data
    const ottData = await loadUserDataFromExcel();
    const userData = ottData.get(userCode);

    if (!userData) {
        userSessions.delete(userIdentifier);
        return;
    }

    try {
        // Login to get UserId
        const loginResult = await login();
        
        const payload = {
            Mode: 1,
            ComplaintNo: 0,
            ContactName: userData.ContactName,
            CustMobileNo: userData.MobileNo,
            Username: userData.Username,
            CompanyName: "RailTel Corporation India Ltd.",
            VendorCode: "RTCIL",
            OperatorCode: "JHRT",
            Email: userData.Email,
            Phone: userData.MobileNo,
            Subject: `${serviceProvider} not working`,
            Description: `Customer is not able to use ${serviceProvider}`,
            Remark: "",
            Status: "O",
            TicketOwner: "Angad",
            ServiceProvider: serviceProvider,
            IssueType: "Subscription",
            ReportedDate: new Date().toISOString().slice(0, 16),
            Priority: "High",
            Channel: "Phone",
            Classifications: "Problem",
            UserId: loginResult.UserId
        };

        // Submit complaint
        const response = await axios.post(
            'http://apiv1.inteligo.tech/api/OTT/GOTTComplaintRegistration',
            payload
        );

        const result = response.data;

        // Fetch updated complaint list to get latest complaint
        const complaintsResponse = await axios.post(
            `http://apiv1.inteligo.tech/api/OTT/GGetOTTComplaintList?UserID=${loginResult.UserId}`,
            loginResult.UserId
        );

        const complaints = complaintsResponse.data;
        const latestComplaint = complaints.length > 0 ? complaints[0] : null;

        // Build reply
        const apiMessage = result.ErrorMsg || "Unknown response from server.";
        let reply = `*${apiMessage}*\n\n`;
        reply += `*Username:* ${userData.Username}\n`;

        if (latestComplaint) {
            reply += `*Complaint No.:* ${latestComplaint.ComplaintNumber}\n`;
            reply += `*Status:* ${latestComplaint.Status}\n`;
        }

        reply += "\n*OTT Team se call aayega customer ko inform kar den aap*.";

        await chat.sendMessage(reply);

    } catch (error) {
        await chat.sendMessage(`❌ Error submitting complaint for ${userCode}.\n\nError: ${error.message}`);
    }

    userSessions.delete(userIdentifier);
};

// Subjects list (already present in your file, keep it as global)
const subjects = [
  "Activate with available balance", "AGNP bank details updation", "ANP - Mobile number and Email ID change",
  "ANP address change", "ANP Demo ID renewal", "ANP disbursement issue", "ANP GSTIN issue",
  "ANP name change", "ANP online recharge issue", "ANP-AGNP mapping", "Authentication issue",
  "BSS issue", "CRM ticket issue", "CSV download option issue", "Data usage issue", "Decommission date updation",
  "disable sub-online recharge", "DOC updation", "Double recharge", "DVR IP Port Request",
  "Enable sub-online recharge", "IFSC code issue", "Invoice issue", "Location transfer",
  "Others", "Package change", "Permanent Inactive Request", "Plan Implementation", "Plan Upgradation",
  "SLA dashboard issue", "Stale session", "Static IP DoP updation", "Static IP recharge issue",
  "Static IP renewal issue", "Sub - Mobile number and Email ID Change", "Subscriber address change",
  "Subscriber applicant name change", "Subscriber GSTIN change", "Subscriber GSTIN issue",
  "Subscriber GSTIN Removal", "Subscriber KYC-Application Mapping", "Subscriber KYC/Application issue",
  "Subscriber online recharge issue", "Subscriber package issue", "Subscriber static IP issue",
  "Subscription expiry", "Subscription type change", "User Reactivation", "Username change",
  "Wrong recharge"
];


// Main SLA Ticket Creation Function
const createSLATicket = async (message) => {
    const chat = await message.getChat();

    try {
        // Step 1: Login
        const loginResponse = await axios.post(
            'https://sla.railwire.co.in/rlogin/index ',
            new URLSearchParams({
                username: 'MSP-JH',
                password: 'Wired&Wireless',
            }),
            {
                maxRedirects: 0,
                validateStatus: status => status === 303,
            }
        );

        const setCookieHeader = loginResponse.headers['set-cookie'];
        if (!setCookieHeader || setCookieHeader.length === 0) {
            throw new Error('Login failed: No session cookie received');
        }

        const ciSessionCookie = setCookieHeader
            .find(cookie => cookie.startsWith('ci_session='))
            .split(';')[0];

        // Step 2: Show subject list
        let subjectListMsg = "Subject:\n";
        subjects.forEach((subj, i) => {
            subjectListMsg += `${i + 1}. ${subj}\n`;
        });
        await chat.sendMessage(subjectListMsg);

        // Step 3: Wait for subject selection
        const subjectMessage = await waitForReply(message);
        const subjectIndex = parseInt(subjectMessage.body.trim());
        const selectedSubject = subjects[subjectIndex - 1];

        if (!selectedSubject) {
            await chat.sendMessage("❌ Invalid subject selection.");
            return;
        }

        // Step 4: Ask for description (single message input)
        await chat.sendMessage("Enter description:");
        const descMessage = await waitForReply(message);
        const desc = descMessage.body.trim(); // Accepts multiline input

        // Step 5: Confirm sending without preview
        await chat.sendMessage("✅ Do you want to send the request? Type *yes* or *no*.");

        const confirmMessage = await waitForReply(message);
        if (confirmMessage.body.trim().toLowerCase() !== 'yes') {
            await chat.sendMessage("🚫 Request canceled.");
            return;
        }

        // Step 6: Submit form
        const form = new FormData();
        form.append('desc', desc);
        form.append('subject', selectedSubject);
        form.append('project', 'Retail');
        form.append('scode', 'JH');
        form.append('mspid', '11');
        form.append('circle', 'JH');
        form.append('assig_date', 'undefined');

        await axios.post(
            'https://sla.railwire.co.in/mspcntl/addmspincident ',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    Cookie: ciSessionCookie,
                }
            }
        );

        // Step 7: Fetch latest incident
        const qs = require('qs');
        const ajaxPayload = qs.stringify({
            draw: 1,
            start: 0,
            length: 1,
            incident_status: 'Pending',
            descp: '',
            s_date: '',
            'search[value]': '',
            'search[regex]': false,
            ...Array.from({ length: 7 }).reduce((acc, _, i) => ({
                ...acc,
                [`columns[${i}][data]`]: ['ticketid', 'msp_created', 'etr', 'status', 'ptype', 'actualclosedate', 'description'][i],
                [`columns[${i}][searchable]`]: true,
                [`columns[${i}][orderable]`]: false,
                [`columns[${i}][search][value]`]: '',
                [`columns[${i}][search][regex]`]: false
            }), {})
        });

        const ajaxResponse = await axios.post(
            'https://sla.railwire.co.in/mspcntl/msp_incident_details_ajax ',
            ajaxPayload,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Cookie': ciSessionCookie
                }
            }
        );

        const incidents = ajaxResponse.data?.data;
        if (incidents && incidents.length > 0) {
            const ticketId = incidents[0].ticketid;
            await chat.sendMessage(`✅ Incident created successfully! Ticket ID: #${ticketId}`);
        } else {
            await chat.sendMessage("⚠️ Incident submitted but no ticket ID found.");
        }

    } catch (error) {
        console.error('Error creating SLA ticket:', error.message);
        await chat.sendMessage("❌ Failed to create SLA ticket.");
    }
};

const handleTicketActivation = async (message) => {
  const chat = await message.getChat();
  await chat.sendMessage("*++* Working *++*");

  try {
    // Step 1: Get cookies
    const cookies = await getCookies();
    if (!cookies) {
      await chat.sendMessage("Authentication failed. Try again later.");
      return;
    }

    const createClient = (cookies) => axios.create({
      baseURL: 'https://jh.railwire.co.in',
      headers: {
        'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      withCredentials: true,
    });

    const client = createClient(cookies);
    const pageOffsets = ['', '30', '60'];
    const tickets = [];

    // Step 2: Fetch tickets from pages
    for (const offset of pageOffsets) {
      const url = `/crmcntl/bill_tickets${offset ? '/' + offset : ''}`;
      const response = await client.get(url);
      const $ = cheerio.load(response.data);

      $('table#results tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        const respondLink = $(cells[cells.length - 1]).find('a').attr('href');
        const statusText = $(cells[7]).text().trim().toLowerCase();
        const subjectText = $(cells[4]).text().trim();
        const match = respondLink?.match(/\/billticketview\/(\d+)\//);
        if (match) {
          tickets.push({
            ticketId: match[1],
            viewUrl: respondLink,
            status: statusText,
            subject: subjectText.toLowerCase(),
          });
        }
      });
    }

    if (tickets.length === 0) {
      await chat.sendMessage("No tickets found.");
      return;
    }

    let closedCount = 0;
    let skippedCount = 0;
    const processedTickets = [];

    // Step 3: Process each ticket - only handle open/progress with active sessions
    for (const ticket of tickets) {
      // Skip if not open or progress
      if (!['open', 'progress'].includes(ticket.status)) {
        skippedCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          status: 'skipped',
          reason: 'Not open/progress status',
          subject: ticket.subject,
        });
        continue;
      }

      // Get subscriber ID from ticket details
      const detailRes = await client.get(ticket.viewUrl);
      const $$ = cheerio.load(detailRes.data);
      let subscriberId = null;

      $$('table.table-bordered.table-striped.table-condensed tbody tr').each((i, row) => {
        const label = $$(row).find('td:first-child').text().trim().toLowerCase();
        const value = $$(row).find('td:nth-child(2)').text().trim();
        if (label === 'subscriber') {
          subscriberId = value;
        }
      });

      ticket.subscriberId = subscriberId || 'N/A';

      // Only check connectivity-related tickets
      const autoCloseSubjects = ['no connectivity', 'wireless network issue'];
      const shouldCheckSession = autoCloseSubjects.some(subject =>
        ticket.subject.includes(subject)
      );

      if (shouldCheckSession && subscriberId) {
        try {
          const sessionStatus = await checkSessionStatus(client, cookies, subscriberId);
          if (sessionStatus === 'Active') {
            // Close the ticket
            const closePayload = new URLSearchParams({
              ticketid: ticket.ticketId,
              response: 'Dear customer, link has been restored.',
              railwire_test_name: cookies.railwireCookie.value,
            });

            const closeResponse = await client.post('/crmcntl/close_ticket', closePayload.toString());

            if (closeResponse.status === 200) {
              closedCount++;
              processedTickets.push({
                ticketId: ticket.ticketId,
                subscriberId: ticket.subscriberId,
                status: 'closed',
                reason: 'Connection restored',
                subject: ticket.subject,
              });
            } else {
              skippedCount++;
              processedTickets.push({
                ticketId: ticket.ticketId,
                subscriberId: ticket.subscriberId,
                status: 'skipped',
                reason: 'Close request failed',
                subject: ticket.subject,
              });
            }
          } else {
            // Session not active - skip
            skippedCount++;
            processedTickets.push({
              ticketId: ticket.ticketId,
              subscriberId: ticket.subscriberId,
              status: 'skipped',
              reason: 'Session not active',
              subject: ticket.subject,
            });
          }
        } catch (err) {
          skippedCount++;
          processedTickets.push({
            ticketId: ticket.ticketId,
            subscriberId: ticket.subscriberId,
            status: 'skipped',
            reason: `Session check failed: ${err.message}`,
            subject: ticket.subject,
          });
        }
      } else {
        // Not a connectivity ticket or no subscriber ID - skip
        skippedCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          subscriberId: ticket.subscriberId,
          status: 'skipped',
          reason: shouldCheckSession ? 'No subscriber ID' : 'Not connectivity issue',
          subject: ticket.subject,
        });
      }
    }

    // Step 4: Simple summary
    let ticketSummary = "🎯 *Ticket Processing Results*\n\n";
    
    ticketSummary += `*📊 Summary:*\n\n`;
    ticketSummary += `✅ ${closedCount} Closed (Session Active)\n`;
    ticketSummary += `⏭️ ${skippedCount} Skipped (Various Reasons)\n\n`;

    const closedTickets = processedTickets.filter(t => t.status === 'closed');

    if (closedTickets.length > 0) {
      ticketSummary += `*🔒 Closed (${closedTickets.length}):*\n`;
      for (const ticket of closedTickets) {
        ticketSummary += `#${ticket.ticketId} (${ticket.subscriberId})\n`;
      }
      ticketSummary += `\n`;
    }
    
    await chat.sendMessage(ticketSummary);

  } catch (error) {
    console.error('Error in handleTicketActivation:', error);
    await chat.sendMessage(`Error processing tickets: ${error.message}`);
  }
};

// Helper function to check session status
async function checkSessionStatus(client, cookies, subscriberCode) {
  try {
    const payload = new URLSearchParams({
      railwire_test_name: cookies.railwireCookie.value,
      'user-search': subscriberCode
    });

    // Step 1: Search subscriber
    const searchRes = await client.post('/billcntl/searchsub', payload.toString());
    const $ = cheerio.load(searchRes.data);
    const detailLink = $('a[href^="/billcntl/subscriptiondetail/"]').attr('href');
    
    if (!detailLink) {
      throw new Error('Subscriber detail link not found');
    }

    // Step 2: Get subscriber detail page
    const detailPageRes = await client.get(detailLink);
    const $$ = cheerio.load(detailPageRes.data);

    // Step 3: Check session status via data usage page
    const dataUsageLink = $$('a[href^="/billcntl/currentmonthdatause/"]').attr('href');
    if (!dataUsageLink) {
      throw new Error('Data usage link not found');
    }

    const usagePageRes = await client.get(dataUsageLink);
    const $$$ = cheerio.load(usagePageRes.data);
    
    // Check if disconnect button exists (indicates active session)
    const sessionActive = $$$('#cusdiscon_btn').length > 0;
    
    return sessionActive ? 'Active' : 'Not Active';
  } catch (err) {
    console.warn(`Session status check failed for ${subscriberCode}:`, err.message);
    return 'Not Active';
  }
}

async function ChangePlan(formData, username, cookies) {
    const url = 'https://jh.railwire.co.in/finapis/msp_plan_applynow';

        const railwireCookie = cookies.railwireCookie;
        const ciSessionCookie = cookies.ciSessionCookie;


    if (!railwireCookie || !ciSessionCookie) {
        throw new Error('Missing required cookies');
    }


    const payload = {
        verifyHidden: formData.verifyHidden,
        subid: formData.subid,
        pkgid: formData.pkgid,
        status: formData.status,
        status: 1,
        uname: username,
        oldpkgid: formData.oldpkgid,
        railwire_test_name: railwireCookie.value
    };

    const payloadToSend = new URLSearchParams(payload).toString();
    console.log(payloadToSend);

    try {
        const response = await axios.post(url, payloadToSend, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `${railwireCookie.name}=${railwireCookie.value}; ${ciSessionCookie.name}=${ciSessionCookie.value}`
            }
        });
		console.log(`Plan changed : "${response.data.STATUS}"`);

        return response.data.STATUS === 'OK';
    } catch (error) {
        console.error('\n❌ Error changing plan:');
        if (error.response) {
            console.error("Status Code:", error.response.status);
            console.error("Response Body:\n", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Message:", error.message);
        }
        return false;
    }
}

const processActions = async (message, userIdentifier, wantsSessionReset, wantsPasswordReset, wantsDeactiveID) => {
    const session = userSessions.get(userIdentifier);
    // Check for the new 'userCodes' array property
    if (!session || !session.userCodes || session.userCodes.length === 0) {
        // If no codes are in session, do nothing.
        userSessions.delete(userIdentifier);
        return;
    }

    const { userCodes } = session;
    const cookies = await getCookies();
    const userDataMap = await loadUserDataFromExcel();

    // Loop through each user code stored in the session
    for (const userCode of userCodes) {
        let fetchedUserData = userDataMap.get(userCode) || await fetchUserDataFromPortal(userCode);
        
        if (fetchedUserData) {
            // Initialize results for this specific user code
            let passwordResetResult = null;
            let deactivateResult = null;

            const maskedName = maskName(toTitleCase(fetchedUserData.Name));
            const maskedId = maskUsername(userCode);
            let responseMessage = `*Name:* ${maskedName}\n*ID:* ${maskedId}`;

            if (wantsSessionReset) {
                console.log(`Requested Session Cleaning for ${userCode}...`);
                const sessionStatus = await resetSession(fetchedUserData, cookies);

                if (sessionStatus === 'SUCCESS') {
                    responseMessage += '\n*Session clear kr diya gya h* ✅';
                } else if (sessionStatus === 'NOT_ACTIVE') {
                    responseMessage += '\nSession active nhi hai ❌';
                } else {
                    responseMessage += '\nFailed to reset session ❌';
                }
            }
            
            if (wantsDeactiveID) {
                console.log(`Activating Deactivated ID for ${userCode}...`);
                deactivateResult = await DeactivateID(fetchedUserData, cookies);
                responseMessage += '\n' + (deactivateResult ? '*Subscriber activated* ✅' : 'Failed to active ❌');
            }

            if (wantsPasswordReset) {
                console.log(`Requested Password Resetting for ${userCode}...`);
                passwordResetResult = await resetPassword(fetchedUserData, cookies);
                if (passwordResetResult.portalReset && passwordResetResult.pppoeReset) {
                    responseMessage += '\n*Reset kr diya gya hai* ✅';
                } else {
                    console.log('Reset failed due to Server Issue.');
                    responseMessage += '\nPassword reset failed';
                }
            }
        
            await message.reply(responseMessage);
        } else {
            console.log(`No user data found for JH code or ID: ${userCode}`);
            await message.reply(`Sahi ID btaye yeh galat h: ${userCode}`);
        }
    }

    // Delete the session after processing all user codes
    userSessions.delete(userIdentifier);
};

const processTasks = async (cookies, originalMessage) => {
    try {
        const { data } = await axios.get(mainURL, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 5000 
        });
        const $ = cheerio.load(data);
        const submittedTasks = [];
        const verifiedTasks = [];

        $('table tbody tr').each((_, el) => {
            const cells = $(el).find('td');
            const status = $(cells[1]).text().trim().toLowerCase();
            const link = $(cells[2]).find('a').attr('href');
            const oltabid = link?.split('/')[3];
            if (status === 'submitted' && link) submittedTasks.push({ link, oltabid });
            else if (status === 'verified' && link) verifiedTasks.push({ link });
        });

        const results = {
            submitted: { total: submittedTasks.length, processed: 0 },
            verified: { total: verifiedTasks.length, processed: 0 }
        };

        for (const { link, oltabid } of submittedTasks) {
            if (await handleSubmittedForm(link, oltabid, cookies, null, originalMessage)) results.submitted.processed++;
        }
        for (const { link } of verifiedTasks) {
            if (await handleVerifiedForm(link, cookies, originalMessage)) results.verified.processed++;
        }

        return results;
    } catch (err) { 
        console.error(`Error processing tasks: ${err.message}`); 
        return null;
    }
};

const processAllForms = async (cookies, originalMessage) => {
    let totalProcessed = 0;
    let isComplete = false;

    while (!isComplete) {
        const results = await processTasks(cookies, originalMessage);
        if (results) {
            totalProcessed += results.submitted.processed + results.verified.processed;
            console.log(`Processed ${results.submitted.processed} Submitted and ${results.verified.processed} Verified Forms.`);

            if (results.submitted.processed === 0 && results.verified.processed === 0) {
                isComplete = true;
            }
        } else {
            console.log('Failed to process KYC tasks. Retrying...');
        }

        if (!isComplete) {
            console.log('Fetching Remaining Application Forms..');
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 5 seconds before refreshing
        }
    }

    return totalProcessed;
};

const getHiddenInputs = async (link, cookies) => {
    try {
        const { data } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(data);
        const extract = (name) => $(`input[name=${name}]`).val()?.toLowerCase();
        return {
            firstname: extract('firstname'),
            oltabid: extract('oltabid'),
            pggroupid: extract('pggroupid'),
            pkgid: extract('pkgid'),
            anp: extract('anp'),
            vlanid: $('select#vlanid option:selected').val()?.toLowerCase(),
            caf_type: extract('caf_type'),
            mobileno: extract('mobileno')
        };
    } catch (err) { console.error(`Error extracting inputs from ${link}: ${err.message}`); return {}; }
};

const getUsername = async (firstName, baseUsername, cookies) => {
    const tryDerive = async (modUsername) => {
        try {
            const payload = new URLSearchParams({
                fname: firstName,
                lname: '',
                mod_username: modUsername,
                railwire_test_name: cookies.railwireCookie.value
            }).toString();
            const { data } = await axios.post(`${baseURL}/kycapis/derive_username`, payload, { 
                headers: { 
                    Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 9000 
            });
            return data;
        } catch { return { STATUS: 'ERROR' }; }
    };

    let attempt = 0;
    let response;
    do {
        response = await tryDerive(baseUsername + (attempt || ''));
        attempt++;
    } while (response.STATUS !== 'OK' && attempt < 10);

    return response.UNAME || null;
};

const createSubscription = async (link, derivedUsername, cookies, originalMessage) => {
    try {
        const hiddenInputs = await getHiddenInputs(link, cookies);
        if (!hiddenInputs.oltabid || !hiddenInputs.pggroupid || !hiddenInputs.pkgid) {
            throw new Error('Required hidden inputs not found');
        }

        // Extract the existing username from the form
        const { data: formData } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(formData);
        const existingUsername = ($('input#uname').attr('value') || $('input#dusername_org').attr('value') || '').trim();

        // Present options to user
        let optionsMessage = `Choose username option:\n`;
        if (existingUsername) {
            optionsMessage += `1. Default Username: ${existingUsername}\n`;
        }
        optionsMessage += `2. Bot Username: ${derivedUsername}\n`;
        optionsMessage += `3. Input Username manually\n`;
        
        await originalMessage.reply(optionsMessage);
        
        const userChoice = await waitForReply(originalMessage);
        let finalUsername;

        switch(userChoice.body.trim()) {
            case '1':
                if (existingUsername) {
                    const verifiedExisting = await getUsername(hiddenInputs.firstname, existingUsername, cookies);
                    if (verifiedExisting) {
                        finalUsername = existingUsername;
                    } else {
                        return false;
                    }
                }
                break;
            case '2':
                finalUsername = derivedUsername;
                break;
            case '3':
                await originalMessage.reply("Input Manual Username:");
                const manualUsernameMessage = await waitForReply(originalMessage);
                const manualUsername = manualUsernameMessage.body.trim();
                const verifiedManual = await getUsername(hiddenInputs.firstname, manualUsername, cookies);
                if (verifiedManual) {
                    finalUsername = manualUsername;
                } else {
                    return false;
                }
                break;
            default:
                await originalMessage.reply("Invalid option.");
                return false;
        }

        if (!finalUsername) return false;

        const payload = new URLSearchParams({
            oltabid: hiddenInputs.oltabid,
            uname: finalUsername,
            pggroupid: hiddenInputs.pggroupid,
            pkgid: hiddenInputs.pkgid,
            anp: hiddenInputs.anp,
            vlanid: hiddenInputs.vlanid,
            caf_type: hiddenInputs.caf_type,
            railwire_test_name: cookies.railwireCookie.value,
            mobileno: hiddenInputs.mobileno
        }).toString();

        const { status, data: subscriptionResponse } = await axios.post(`${baseURL}/kycapis/create_subscription`, payload, { 
            headers: { 
                Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 9000 
        });
        
        if (subscriptionResponse.STATUS === undefined) {
            throw new Error('Cookie expired during subscription creation');
        }
        
        console.log(status === 200 ? 'Subscription created.' : 'Subscription failed.', subscriptionResponse);
        
        if (status === 200) {
            const userData = await fetchUserDataFromPortal(finalUsername);
            if (userData) {
                const resetResponse = await resetPassword(userData, cookies);
                console.log('Password reset response:', resetResponse);
            } else {
                console.error('Failed to fetch user data for password reset.');
            }
        }
        return status === 200;
    } catch (err) {
        console.error(`Error creating subscription: ${err.message}`);
        return false;
    }
};


const handleVerifiedForm = async (link, cookies, originalMessage) => {
    try {
        const { data } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(data);
        const firstName = (await getHiddenInputs(link, cookies)).firstname?.split(' ')[0]?.toLowerCase();
        if (!firstName) throw new Error('First name not found.');

        const associatedPartner = $(`.profile-info-name:contains('Associated Partner')`).next().text().trim().toLowerCase();
        const jhCode = jhCodeMap?.get(associatedPartner);
        if (!jhCode) throw new Error('JH Code not found for partner.');

        const baseUsername = `${jhCode}.${firstName}`;
        const finalUsername = await getUsername(firstName, baseUsername, cookies);
        if (!finalUsername) throw new Error('Failed to derive username.');

        return await createSubscription(link, finalUsername, cookies, originalMessage);
    } catch (err) { 
        console.error(`Error processing verified form: ${err.message}`); 
        return false;
    }
};

const loadSubscriberData = (filename = 'Subscribers.xlsx') => {
    if (subscriberDataCache) return subscriberDataCache;

    try {
        const filePath = path.join(__dirname, filename);
        if (!fs.existsSync(filePath)) {
            console.error(`Error: ${filename} not found.`);
            subscriberDataCache = new Map();
            return subscriberDataCache;
        }

        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);

        subscriberDataCache = new Map();

        for (const row of rows) {
            const subscriberId = normalize(row['Subscriber']);
            const username = normalize(row['Username']);

            const subscriberDetails = {
                'Subscriber ID': row['Subscriber ID'],
                'Username': row['Username'],
                'ANP ID': row['ANP ID'],
                'ANP Name': row['ANP Name'],
                'District': row['District'],
                'Stack VLAN': row['Stack VLAN'],
                'Customer VLAN': row['Customer VLAN'],
                'JH Code': row['JH Code'],
                'Subscriber Count': row['Subscriber Count'],
                'Port': row['Port'],
                'Backup Port': row['Backup Port'],
                'BNG': row['BNG'],
                'Marketing Team': row['Marketing Team Name'],
                'Marketing Team No.': row['Marketing Team No.'],
            };

            if (subscriberId) subscriberDataCache.set(subscriberId, subscriberDetails);
            if (username) subscriberDataCache.set(username, subscriberDetails);
        }
        return subscriberDataCache;
    } catch (err) {
        console.error(`Error reading subscriber data from Excel: ${err.message}`);
        return new Map();
    }
};

const handleSubmittedForm = async (link, oltabid, cookies, username, originalMessage) => {
    try {
      const { data } = await axios.get(`${baseURL}${link}`, { 
        headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
        timeout: 8000
      });
      const $ = cheerio.load(data);
  
      // Extracting Address Proof
      const addressProofElement = $(`.profile-info-name:contains('Address Proof Copy')`).next().find('span');
      const addressProof = addressProofElement.length > 0 && addressProofElement.text().trim().toLowerCase() === 'file not exists' ? 'file not exists' : 'View';
      const mobileNo = $(`.profile-info-name:contains('Mobile No.')`).next().find('span').text().trim();
  
      if (addressProof === 'file not exists') {
        console.log('Marking as verified because file not exists.');
        const payload = new URLSearchParams({ 
          oltabid, 
          mobileno_dual: mobileNo, 
          railwire_test_name: cookies.railwireCookie.value 
        }).toString();
        await axios.post(`${baseURL}/kycapis/kyc_mark_verified`, payload, { 
          headers: { 
            Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 5000 
        });
        return true;
      } else {
        console.log(`Address proof exists for mobile ${mobileNo}.`);

        let extractedData = `Address Proof for No.: ${mobileNo}\n\nDetails:\n`;
    
        $('.profile-info-row').each((index, element) => {
          const infoName = $(element).find('.profile-info-name').text().trim();
          const infoValueElement = $(element).find('.profile-info-value span');
  
          let infoValue = infoValueElement.text().trim();
  
          // Handle links specifically
          const linkElement = infoValueElement.find('a');
          if (linkElement.length > 0) {
            const link = linkElement.attr('href');
            infoValue = `View >> ${baseURL}${link}`;
          }
  
          if (
            !infoName.toLowerCase().includes('notice') &&
            !infoName.toLowerCase().includes('reason for kyc rejection') &&
            !infoName.toLowerCase().includes('address type') &&
            !infoName.toLowerCase().includes('id no') &&
            !infoName.toLowerCase().includes('door no') &&
            !infoName.toLowerCase().includes('street') &&
            !infoName.toLowerCase().includes('applied package')
          ) {
            extractedData += `${infoName}: ${infoValue}\n`;
          }
        });
  
        // Send the extracted data to the user
        await originalMessage.reply(extractedData);
        await originalMessage.reply(`Do you want to verify? (y/n)`);
  
        const userInputMessage = await waitForReply(originalMessage);
        const userInput = userInputMessage.body.toLowerCase();
  
        if (userInput.startsWith('y')) {
          const payload = new URLSearchParams({ 
            oltabid, 
            mobileno_dual: mobileNo, 
            railwire_test_name: cookies.railwireCookie.value 
          }).toString();
          await axios.post(`${baseURL}/kycapis/kyc_mark_verified`, payload, { 
            headers: { 
              Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 5000 
          });
          return true;
        } else {
          console.log('User choose not to verify. Skipping verification.');
          return false;
        }
      }
    } catch (err) { 
      console.error(`Error processing submitted form for ${username}: ${err.message}`); 
      return false;
    }
  };
 
const handleIncomingMessage = async (message) => {
    const chat = await message.getChat();
    if (chat.isGroup && chat.name === 'Railtel & MSP team Jharkhand') {
        console.log('MSP group messages ignoring!!');
        return;
    }

    const userIdentifier = getUserIdentifier(message);
    const messageBody = message.body.toLowerCase().trim();

    console.log(`User Detail: ${userIdentifier}`);
    console.log(`Message: ${messageBody}`);

    if (messageBody === 'subscount') {
    const count = await getSubscriberCount();
    const formattedTime = new Date().toLocaleTimeString('en-US');
    const replyMessage = `*Time:* ${formattedTime}\n*Active Subscriber:* *${count}*\n\nNext count in *1 hour* ⏳.\nTo check anytime type: *subscribercount*`;
    await message.reply(replyMessage);
    return;
    }

    if (messageBody.startsWith('search ')) {
        const searchTerm = message.body.substring(7).trim();
        await handleSubscriberSearch(message, searchTerm);
        return;
    }

    if (messageBody === 'anpupdate') {
        await handleAnpUpdate(message);
        return;
    }

    if (messageBody === 'subsupdate') {
        await handleSubscriberUpdate(message);
        return;
    }

    if (messageBody === 'ticketupdate') {
        await handleTicketActivation(message);
        return;
    }
    if (messageBody.includes('checkott')) {
        await checkComplaintStatus(message);
        return;
    }

    if (messageBody === 'slastart') {
        await createSLATicket(message);
        return;
    }

    if (messageBody.includes('planchange') || messageBody.includes('planupdate')) {
        await handlePlanChange(message);
        return;
    }

    if (messageBody === 'cafupdate') {
        const cookies = await getCookies();
        if (!cookies) {
            await message.reply('Failed to authenticate. Please try again later.');
            return;
        }

        await message.reply('Looking for KYC...');
        const totalProcessed = await processAllForms(cookies, message);
        await message.reply(`Processed + Verified: ${totalProcessed}`);
        return;
    }

    // Pattern matching for JH codes and subscriber IDs (using global flag 'g' to find all matches)
    const SESSION_TIMEOUT_MS = 600000;      // 10 minutes
    const ACCUMULATION_WINDOW_MS = 120000;  // 2 minutes
    
    // More specific pattern matching
    const codePattern = /jh(\.\w+){2,}/gi;
    const subscriberIdPattern = /(?<!\d)\b\d{4,6}\b(?!\d)/g;
    
    const codeMatches = messageBody.match(codePattern) || [];
    const subscriberIdMatches = messageBody.match(subscriberIdPattern) || [];
    const allUserCodesInThisMessage = [...new Set([...codeMatches, ...subscriberIdMatches])].map(c => c.toLowerCase());

    if (allUserCodesInThisMessage.length > 0) {
        const now = Date.now();
        const existingSession = userSessions.get(userIdentifier);
        let updatedUserCodes = allUserCodesInThisMessage;

        // If a recent session exists, accumulate IDs. Otherwise, the new list is used.
        if (existingSession && (now - existingSession.lastUpdated < ACCUMULATION_WINDOW_MS)) {
            updatedUserCodes = [...new Set([...existingSession.userCodes, ...allUserCodesInThisMessage])];
        }

        // Clear any old timeout and set a new 10-minute master timeout
        if (existingSession?.timeoutId) clearTimeout(existingSession.timeoutId);
        const newTimeoutId = setTimeout(() => userSessions.delete(userIdentifier), SESSION_TIMEOUT_MS);

        userSessions.set(userIdentifier, { userCodes: updatedUserCodes, lastUpdated: now, timeoutId: newTimeoutId });
    }

    // Action keywords
    const wantsSessionReset = /\b(season|session|ip reset|mac)\b/i.test(messageBody);
    const wantsDeactiveID = /\b(reactive|reactivate|re-active|re-activated|deactivated)\b/i.test(messageBody);
    const wantsPasswordReset = /\b(reset|risat|resat|resert|resate|risit|rest|reser|riset)\b/i.test(messageBody);

    // Handle OTT
    let serviceProvider = null;
    if (/\b(hotstar|jiohotstar)\b/i.test(messageBody)) serviceProvider = 'Hotstar_Super';
    else if (/\b(sony|sonyliv)\b/i.test(messageBody)) serviceProvider = 'SonyPremium';

    if (serviceProvider && userSessions.has(userIdentifier)) {
        const session = userSessions.get(userIdentifier);
        if (session.userCodes?.length > 0) {
            userSessions.set(userIdentifier, { ...session, userCode: session.userCodes[0] });
            await processOTTComplaint(message, userIdentifier, serviceProvider);
        }
        return;
    }
    
    // Handle standard actions and clear session afterwards
    if ((wantsSessionReset || wantsPasswordReset || wantsDeactiveID) && userSessions.has(userIdentifier)) {
        const session = userSessions.get(userIdentifier);
        if (session?.timeoutId) clearTimeout(session.timeoutId);
        await processActions(message, userIdentifier, wantsSessionReset, wantsPasswordReset, wantsDeactiveID);
    }
};

client.on('ready', () => {
    loadAllData();
    botStartTime = Date.now();
    const scheduledTask = async () => {
        try {
            const count = await getSubscriberCount();
            if (!count || count.includes('not found') || count.includes('retrieve')) return;

            const now = new Date();
            const formattedTime = now.toLocaleTimeString('en-US');
            let message;

            // This is the new logic to change the message based on the time
            if (now.getHours() === 0) { // Checks if the current hour is 0 (12:00 AM)
                message = `*Time:* ${formattedTime}\n*Active Subscriber:* *${count}*\n\nNext count at *9 AM* ☀️.\nTo check anytime type: *subscount*`;
            } else {
                message = `*Time:* ${formattedTime}\n*Active Subscriber:* *${count}*\n\nNext count in *1 hour* ⏳.\nTo check anytime type: *subscount*`;
            }

            const chats = await client.getChats();
            const targetGroups = ["LIGHTWAVE SALES GROUP", "Lightwave Technologies | Ranchi Call Center"];

            for (const chat of chats) {
                if (chat.isGroup && targetGroups.includes(chat.name)) {
                    await chat.sendMessage(message);
                }
            }
        } catch (error) {
            console.error('Scheduled count task failed:', error.message);
        }
    };

    // This schedule runs at midnight (0) and then every hour from 9 AM (9) to 11 PM (23)
    cron.schedule('0 0,9-23 * * *', scheduledTask, { timezone: "Asia/Kolkata" });

    // This schedule still runs at 11:59 PM as requested
    cron.schedule('59 23 * * *', scheduledTask, { timezone: "Asia/Kolkata" });
    console.log('WhatsApp bot ready to use!!');
});

client.on('qr', generateQRCode);

client.on('message', (message) => {
    if (message.timestamp * 1000 < botStartTime) {
        return;
    }
    
    handleIncomingMessage(message);
});

client.initialize();