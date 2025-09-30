const { Pool } = require('undici');
const axios = require('axios');
const cheerio = require('cheerio');
const { publicEncrypt, constants } = require('crypto');
const { URLSearchParams } = require('url');
const Tesseract = require('tesseract.js');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const PORTAL_USERNAME = 'support';
const PORTAL_PASSWORD = 'Wave&light1';
const BASE_URL = 'https://jh.railwire.co.in';
const EXCEL_FILENAME = 'User.xlsx';
const CONCURRENT_REQUESTS = 80;
const AUTH_REFRESH_MINUTES = 5;
const LOG_FILE_PATH = path.resolve(__dirname, 'logs.txt');

const pool = new Pool(BASE_URL, {
    connections: CONCURRENT_REQUESTS + 1,
    pipelining: 1,
});

// --- Time formatting helper ---
const formatElapsedTime = (startTime) => {
    const elapsedMs = Date.now() - startTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes} min. ${seconds} sec.`;
};

// --- Logging helper ---
const logResponse = (username, response) => {
    const singleLineResponse = typeof response === 'string'
        ? response.replace(/[\r\n]+/g, ' ')
        : JSON.stringify(response);
    const logEntry = `${username} >>> ${singleLineResponse}\r\n`;
    fs.appendFile(LOG_FILE_PATH, logEntry, err => {
        if (err) console.error('Failed to write log:', err);
    });
};

// --- Cookie Management Helper ---
const updateCookiesFromResponse = (sessionCookies, response) => {
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
    return sessionCookies;
};

const getCookieHeader = (sessionCookies) => {
    return Object.entries(sessionCookies).map(([k, v]) => `${k}=${v}`).join('; ');
};

// --- Retry helper ---
const retryOperation = async (operation, maxRetries = 3, delay = 1000) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            console.error(`Attempt ${attempt} failed: ${error.message}`);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
};

// --- API-based Authentication ---
const authenticate = async (username, password) => {
    console.log('Attempting to log into the portal via API...');
    return retryOperation(async () => {
        let sessionCookies = {};
        
        try {
            // -- Step 1: Get login page and extract tokens
            const loginPageResponse = await axios.get(`${BASE_URL}/rlogin`, { 
                timeout: 30000,
                validateStatus: () => true 
            });
            sessionCookies = updateCookiesFromResponse(sessionCookies, loginPageResponse);
            const currentCookieHeader = getCookieHeader(sessionCookies);
            
            const pageHtml = loginPageResponse.data;
            const $ = cheerio.load(pageHtml);
            const railwireTestToken = $('input[name="railwire_test_name"]').val();
            const dynamicSaltMatch = pageHtml.match(/var salt = '([^']+)';/);
            const dynamicSaltToken = dynamicSaltMatch ? dynamicSaltMatch[1] : null;
            
            if (!railwireTestToken || !dynamicSaltToken) {
                throw new Error('Failed to extract required tokens from login page');
            }

            // -- Step 2: Get and solve CAPTCHA
            const captchaImageUrl = $('#captcha_code').attr('src');
            if (!captchaImageUrl) {
                throw new Error('CAPTCHA image URL not found');
            }
            
            const captchaImageResponse = await axios.get(`${BASE_URL}${captchaImageUrl}`, {
                responseType: 'arraybuffer',
                headers: { 'Cookie': currentCookieHeader },
                timeout: 15000
            });
            
            const { data: { text } } = await Tesseract.recognize(captchaImageResponse.data, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            });
            const captchaText = text.replace(/[^A-Z0-9]/g, '');
            
            if (!captchaText || captchaText.length < 4) {
                throw new Error('CAPTCHA solving failed or text too short');
            }

            // -- Step 3: Get public key for password encryption
            const publicKeyResponse = await axios.get(`${BASE_URL}/rlogin/getPublicKey?token=${dynamicSaltToken}`, {
                headers: { 
                    'X-Requested-With': 'XMLHttpRequest', 
                    'Cookie': currentCookieHeader 
                },
                timeout: 15000
            });
            
            const publicKey = publicKeyResponse.data.publicKey;
            if (!publicKey) {
                throw new Error('Failed to retrieve public key');
            }

            // -- Step 4: Encrypt password
            const encryptedPasswordBase64 = publicEncrypt(
                { 
                    key: publicKey, 
                    padding: constants.RSA_PKCS1_PADDING 
                },
                Buffer.from(`${password}::${dynamicSaltToken}`)
            ).toString('base64');

            // -- Step 5: Submit login form
            const loginFormData = new URLSearchParams({
                railwire_test_name: railwireTestToken,
                username: username,
                password: encryptedPasswordBase64,
                code: captchaText,
                baseurl: '',
            });
            
            const loginResponse = await axios.post(`${BASE_URL}/rlogin`, loginFormData.toString(), {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded', 
                    'Cookie': currentCookieHeader 
                },
                maxRedirects: 0,
                validateStatus: status => status === 303 || status === 302,
                timeout: 30000
            });
            
            sessionCookies = updateCookiesFromResponse(sessionCookies, loginResponse);

            // -- Step 6: Validate login success
            if (loginResponse.status === 303 || loginResponse.status === 302) {
                // Check for required cookies
                const railwireCookie = sessionCookies['railwire_cookie_name'];
                const ciSessionCookie = sessionCookies['ci_session'];
                
                if (!railwireCookie || !ciSessionCookie) {
                    throw new Error('Required session cookies not found after login');
                }
                
                console.log('Login successful via API!');
                return {
                    railwireCookie: { name: 'railwire_cookie_name', value: railwireCookie },
                    ciSessionCookie: { name: 'ci_session', value: ciSessionCookie }
                };
            } else {
                throw new Error(`Login failed with status ${loginResponse.status}`);
            }
            
        } catch (error) {
            console.error('Authentication error:', error.message);
            throw error;
        }
    }, 5, 2000);
};

// --- Reset session for a user ---
const resetSessionFireAndForget = async (username, cookies) => {
    const payload = `uname=${username}&railwire_test_name=${cookies.railwireCookie.value}`;
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
    };

    try {
        const response = await pool.request({
            path: '/billcntl/endacctsession',
            method: 'POST',
            headers,
            body: payload
        });

        const statusCode = response.statusCode;
        const respHeaders = response.headers;

        let responseText = '';
        try {
            responseText = await response.body.text();
        } catch (err) {
            responseText = '[Failed to read body]';
        }

        if (statusCode !== 200 || !responseText.trim()) {
            return JSON.stringify({
                statusCode,
                headers: respHeaders,
                body: responseText || '[Empty body]'
            });
        }

        return responseText.trim();

    } catch (err) {
        throw new Error(err.message || 'Unknown error during session reset');
    }
};

// --- Auth refresh logic with improved handling ---
let isRunning = false;
let authCookies = null;
let lastAuthTime = 0;
let authInProgress = false;
let authFailureCount = 0;
const MAX_AUTH_FAILURES = 3;

const refreshAuthIfNeeded = async (force = false) => {
    const now = Date.now();
    const msSinceAuth = now - lastAuthTime;
    
    // Check if auth refresh is needed
    if (force || !authCookies || msSinceAuth >= AUTH_REFRESH_MINUTES * 60 * 1000) {
        if (authInProgress) {
            // Wait for ongoing auth to complete
            while (authInProgress) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
        }
        
        authInProgress = true;
        try {
            const newCookies = await authenticate(PORTAL_USERNAME, PORTAL_PASSWORD);
            authCookies = newCookies;
            lastAuthTime = Date.now();
            authFailureCount = 0;
        } catch (err) {
            authFailureCount++;
            console.error(`Authentication refresh failed (${authFailureCount}/${MAX_AUTH_FAILURES}):`, err.message);
            
            if (authFailureCount >= MAX_AUTH_FAILURES) {
                console.error('Maximum authentication failures reached. Aborting batch.');
                throw new Error('Authentication permanently failed');
            }
        } finally {
            authInProgress = false;
        }
    }
};

// --- Main batch processing with improved error handling ---
const runBatch = async () => {
    if (isRunning) {
        console.log('A batch run is already in progress - skipping this scheduled start.');
        return;
    }
    isRunning = true;

    console.log(`\n--- Starting batch run at ${new Date().toISOString()} ---`);
    const startTime = Date.now();
    let userList;
    let excelResults = [];

    // -- Step 1: Read Excel file
    try {
        console.log('Reading user list from Excel...');
        const filePath = path.resolve(__dirname, EXCEL_FILENAME);
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        userList = jsonData
            .slice(1)
            .map(row => row[0])
            .filter(username => username && String(username).trim() !== '');

        if (userList.length === 0) {
            console.error('ERROR: No valid usernames found in the first column of the Excel file.');
            isRunning = false;
            return;
        }
        console.log(`Found ${userList.length} users to process with a concurrency of ${CONCURRENT_REQUESTS}.`);
    } catch (error) {
        console.error(`ERROR: Could not read file '${EXCEL_FILENAME}'.`, error);
        isRunning = false;
        return;
    }

    // -- Step 2: Initial authentication
    try {
        console.log('\nPerforming initial authentication...');
        authCookies = await authenticate(PORTAL_USERNAME, PORTAL_PASSWORD);
        lastAuthTime = Date.now();
        authFailureCount = 0;
    } catch (error) {
        console.error(`\n--- CRITICAL ERROR: Initial portal login failed. Aborting batch process. ---`);
        isRunning = false;
        return;
    }

    // -- Step 3: Set up auth refresh interval
    const authRefreshInterval = setInterval(() => {
        refreshAuthIfNeeded().catch(err => {
            console.error('Background auth refresh error:', err.message);
        });
    }, 30 * 1000);

    const totalUsers = userList.length;
    let processedCount = 0;
    let successCount = 0;
    let failCount = 0;
    let retryCount = 0;

    // -- Step 4: Worker function for concurrent processing
    const worker = async () => {
        while (userList.length > 0) {
            const username = userList.shift();
            if (!username) continue;

            try {
                // Check auth before each request
                await refreshAuthIfNeeded();
                
                let responseText = await resetSessionFireAndForget(username, authCookies);
                let status = 'Unknown';
                let message = responseText;

                // Parse response
                try {
                    const json = JSON.parse(responseText);
                    status = json.STATUS || 'Unknown';
                    message = json.message || responseText;
                } catch (err) {
                    status = 'Raw';
                    message = responseText;
                }

                // -- Step 5: Detect and handle session expiry
                if (status === 'Raw' || 
                    responseText.includes('statusCode') || 
                    responseText.includes('Empty body') ||
                    responseText.includes('session expired') ||
                    responseText.includes('login required')) {
                    
                    retryCount++;

                    // Force re-authentication
                    try {
                        await refreshAuthIfNeeded(true);
                        
                        // Retry the request with new auth
                        responseText = await resetSessionFireAndForget(username, authCookies);
                        try {
                            const json = JSON.parse(responseText);
                            status = json.STATUS || 'Unknown';
                            message = json.message || responseText;
                        } catch (err) {
                            status = 'Raw';
                            message = responseText;
                        }
                    } catch (retryErr) {
                        status = 'Failed';
                        message = `Retry after re-auth failed: ${retryErr.message}`;
                    }
                }

                excelResults.push({ Username: username, Status: status, Message: message });
                logResponse(username, responseText);
                successCount++;

            } catch (error) {
                failCount++;
                excelResults.push({ Username: username, Status: 'Failed', Message: error.message });
                logResponse(username, `Failed: ${error.message}`);
            } finally {
                processedCount++;
                const percentage = ((processedCount / totalUsers) * 100).toFixed(2);
                const elapsedTime = formatElapsedTime(startTime);
                process.stdout.write(`Progress: ${processedCount}/${totalUsers} (${percentage}%) | Success: ${successCount} | Failed: ${failCount} | Retries: ${retryCount} | Time: ${elapsedTime}\r`);
            }
        }
    };

    // -- Step 6: Launch concurrent workers
    console.log('\nStarting concurrent processing...');
    const workerPromises = [];
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
        workerPromises.push(worker());
    }

    await Promise.all(workerPromises);
    clearInterval(authRefreshInterval);

    // -- Step 7: Write Excel results
    try {
        const worksheet = XLSX.utils.json_to_sheet(excelResults, { header: ['Username', 'Status', 'Message'] });
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
        const excelPath = path.resolve(__dirname, 'logs.xlsx');
        XLSX.writeFile(workbook, excelPath);
        console.log(`\nExcel log saved to ${excelPath}`);
    } catch (err) {
        console.error('Failed to write Excel file:', err.message);
    }

    // -- Step 8: Final statistics
    const endTime = Date.now();
    const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
    const rps = (totalUsers / durationSeconds).toFixed(2);
    const totalTime = formatElapsedTime(startTime);

    console.log(`\n--- Batch Process Complete ---`);
    console.log(`Total Time: ${totalTime} (${durationSeconds} seconds)`);
    console.log(`Average Speed: ${rps} requests per second`);
    console.log(`Total Users Processed: ${totalUsers}`);
    console.log(`Successful Resets: ${successCount}`);
    console.log(`Failed Resets: ${failCount}`);
    console.log(`Auth Retries: ${retryCount}`);

    isRunning = false;
};

// --- Scheduler (Daily at user-specified time) ---
function scheduleDaily(hour, minute, task) {
    const now = new Date();
    const next = new Date();

    next.setHours(hour, minute, 0, 0);

    // If today's time already passed → schedule tomorrow
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }

    const delay = next - now;

    console.log(
        `Next run scheduled for ${next.toLocaleDateString()} ${next.toLocaleTimeString()} (in ${(delay / 1000 / 60).toFixed(2)} minutes)`
    );

    setTimeout(() => {
        console.log(`\nRunning scheduled task for ${next.toLocaleDateString()} at ${next.toLocaleTimeString()}`);
        task().catch(err => console.error("Scheduled run failed:", err));

        // Reschedule for the next day
        scheduleDaily(hour, minute, task);
    }, delay);
}

// --- Main entry point ---
(async () => {
    console.log('========================================');
    console.log('   IP-Reboot Service (API Method)');
    console.log('========================================');
    console.log(`Configuration:`);
    console.log(`  • Concurrent requests: ${CONCURRENT_REQUESTS}`);
    console.log(`  • Auth refresh interval: ${AUTH_REFRESH_MINUTES} minutes`);
    console.log(`  • User list: ${EXCEL_FILENAME}`);
    console.log('========================================');
    
    // Default schedule time for PM2 (01:00 AM daily)
    const scheduleTime = { hour: 1, minute: 0 };
    console.log('Scheduled for daily run at 01:00 (01:00 AM)');
    
    scheduleDaily(scheduleTime.hour, scheduleTime.minute, async () => {
        if (!isRunning) {
            try {
                await runBatch();
            } catch (err) {
                console.error("Scheduled run failed:", err);
            }
        } else {
            console.log("Scheduled run time reached but previous run still active - skipping this cycle.");
        }
    });
})();

// --- Graceful shutdown ---
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    if (pool) {
        pool.close(() => {
            console.log('Connection pool closed.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});