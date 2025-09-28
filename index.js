const {
    Client,
    LocalAuth,
    MessageMedia
} = require('whatsapp-web.js');

// -- WhatsApp Web client initialization with Puppeteer headless browser configuration
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
const sharp = require('sharp');
const cron = require('node-cron');
const Tesseract = require('tesseract.js');
const axios = require('axios');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
let partnerNameLookupCache = null;
const path = require('path');
const {
    publicEncrypt,
    constants
} = require('crypto');
const {
    URLSearchParams
} = require('url');
const cheerio = require('cheerio');
const XLSX = require('xlsx');
const userSessions = new Map();
let partnerMappings = null;
let partnerIndex = null;
let subscriberDataCache = null;
let partnerLiveDetailsCache = null;
let nmsSessionCache = null;
let lastStillDownReportTime = 0;
const PROCESSED_TICKETS_STATE_FILE_PATH = path.join(__dirname, 'processedTicketsState.json');
const ANP_STATE_FILE_PATH = path.join(__dirname, 'anpDownState.json');
const ANP_REPORT_STATE_FILE_PATH = path.join(__dirname, 'anpReportState.json');
const PackageNameToFilterOut = "FUP10Mbps-1Mbps 30GB";
let processedTicketsState = {};
let sessionCache = null;
const userDataCacheByFile = {};
const downPartnersState = new Map();
// -- Configuration object for ANP (Access Network Provider) monitoring - contains service URLs, target numbers, ignored partner IDs
// In ANP_CONFIG, add these two new properties:
const ANP_CONFIG = {
    SERVICES_URL: 'https://services.railwire.co.in',
    TARGET_ID: '916200493605@c.us',
    GROUP_NAME: 'Super Bot - LightWave',
    EXCEL_FILE_NAME: 'AllData.xlsx',
    IGNORED_PARTNER_IDS: new Set([
        '3474487439', '5283639869', '2568065682', '2425852224', '6378518993',
        '8878892435', '6834570680', '6195650370', '6933249503', '5950839426',
        '5570382470', '2005592154', '3423963007', '1163822769', '1840251248',
        '4352542809', '2090233061', '6096321831', '2692518024',
    ]),
    // --- ADD THESE TWO LINES ---
    AMAN_TARGET_ID: '916200493605@c.us',
    AMAN_DISTRICTS: new Set([
        'Pashchimi Singhbhum',
        'Saraikela-Kharsawan',
        'Purbi Singhbhum'
    ])
    // -------------------------
};

// Helper function to parse CSV data properly
const parseCSVLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
};

// -- Set of allowed ticket subjects that the bot will process and alert on
const ALLOWED_TICKET_SUBJECTS = new Set([
    'slow browsing speed',
    'wireless network issue',
    'plan change',
    'login error / 691',
    'excess charges from lco',
    'user email id and contact number change',
    'fup limit issue',
    'website issue',
    'single static ip',
    'static ip- /29 pool',
    'static ip- /30 pool',
    'no connectivity',
    'others',
    'remove static ip',
    'online recharge issue',
    'package expire',
    'subscription type change request'
]);

// -- Configuration for automated ticket monitoring - target number and cron schedule
const TICKET_MONITOR_CONFIG = {
    TARGET_ID: '916200493605@c.us',
    CRON_SCHEDULE: '*/10 * * * *'
};


const sendAnpAlert = async (message, partnerDetails = null) => {
    if (!partnerDetails) {
        return;
    }
    const district = partnerDetails['District'];
    if (district && ANP_CONFIG.AMAN_DISTRICTS.has(district)) {
        try {
            await client.sendMessage(ANP_CONFIG.AMAN_TARGET_ID, message);
        } catch (error) {
            console.error(`Failed to send ANP alert to Aman: ${error.message}`);
        }
    }
};

// -- Helper Functions Start --

// -- Saves processed ticket state (including message count) to JSON
const saveProcessedTicketsState = () => {
    try {
        const data = JSON.stringify(processedTicketsState, null, 2); // Using JSON object now
        fs.writeFileSync(PROCESSED_TICKETS_STATE_FILE_PATH, data, 'utf8');
    } catch (error) {
        console.error('Error saving processed tickets state:', error.message);
    }
};


// -- Loads previously processed ticket state from JSON on bot startup
const loadProcessedTicketsState = () => {
    try {
        if (fs.existsSync(PROCESSED_TICKETS_STATE_FILE_PATH)) {
            const data = fs.readFileSync(PROCESSED_TICKETS_STATE_FILE_PATH, 'utf8');
            processedTicketsState = JSON.parse(data);
            console.log(`Loaded state for ${Object.keys(processedTicketsState).length} processed tickets from file.`);
        } else {
            processedTicketsState = {}; // Initialize if file doesn't exist
        }
    } catch (error) {
        console.error('Error loading processed tickets state:', error.message);
        processedTicketsState = {}; // Reset on error
    }
};

// -- Saves ANP down state (which partners are currently down) to JSON file
const saveAnpDownState = () => {
    try {
        const data = JSON.stringify(Array.from(downPartnersState.entries()));
        fs.writeFileSync(ANP_STATE_FILE_PATH, data, 'utf8');
    } catch (error) {
        console.error('Error saving ANP down state:', error.message);
    }
};

// -- Loads ANP down state from JSON file to maintain state across bot restarts
const loadAnpDownState = () => {
    try {
        if (fs.existsSync(ANP_STATE_FILE_PATH)) {
            const data = fs.readFileSync(ANP_STATE_FILE_PATH, 'utf8');
            const entries = JSON.parse(data);
            const loadedMap = new Map(entries);
            downPartnersState.clear();
            for (const [key, value] of loadedMap.entries()) {
                downPartnersState.set(key, value);
            }
            console.log(`Loaded ${downPartnersState.size} down ANP states from file.`);
        }
    } catch (error) {
        console.error('Error loading ANP down state:', error.message);
    }
};

const saveAnpReportState = () => {
    try {
        const data = JSON.stringify({ lastStillDownReportTime });
        fs.writeFileSync(ANP_REPORT_STATE_FILE_PATH, data, 'utf8');
    } catch (error) {
        console.error('Error saving ANP report state:', error.message);
    }
};

const loadAnpReportState = () => {
    try {
        if (fs.existsSync(ANP_REPORT_STATE_FILE_PATH)) {
            const data = fs.readFileSync(ANP_REPORT_STATE_FILE_PATH, 'utf8');
            const state = JSON.parse(data);
            if (state && typeof state.lastStillDownReportTime === 'number') {
                lastStillDownReportTime = state.lastStillDownReportTime;
                console.log(`Loaded last ANP report time: ${new Date(lastStillDownReportTime).toLocaleString()}`);
            }
        }
    } catch (error) {
        console.error('Error loading ANP report state:', error.message);
    }
};

// -- Generates random email address based on username for bulk updates
const generateRandomEmail = (username) => {
    if (!username || typeof username !== 'string') {
        return `random${Date.now()}@gmaill.com`;
    }
    const parts = username.split('.');
    const namePart = parts[parts.length - 1];
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `${namePart}${randomNum}@gmaill.com`.toLowerCase();
};

// -- Masks subscriber names by replacing characters with 'x' for privacy
const maskName = (name) => {
    if (!name || typeof name !== 'string') return 'N/A';
    const parts = name.trim().split(/\s+/);
    const maskedParts = parts.map(part => {
        if (part.length <= 3) {
            return part;
        }
        return part.substring(0, 3) + 'x'.repeat(part.length - 3);
    });
    return maskedParts.join(' ');
};

// -- Masks usernames by replacing characters with 'x' for privacy
const maskUsername = (userCode) => {
    if (!userCode || typeof userCode !== 'string') return 'N/A';
    const parts = userCode.split('.');
    if (parts.length >= 3) {
        const namePart = parts[parts.length - 1];
        if (namePart.length > 3) {
            const maskedNamePart = namePart.substring(0, 3) + 'x'.repeat(namePart.length - 3);
            parts[parts.length - 1] = maskedNamePart;
        }
        return parts.join('.');
    }
    if (/^\d{5,}$/.test(userCode)) {
        if (userCode.length <= 3) return userCode;
        return userCode.substring(0, 3) + 'x'.repeat(userCode.length - 3);
    }

    return userCode;
};

// -- Creates header mapping from Excel file headers for data processing
const createHeaderMap = (header) => header.reduce((acc, col, index) => {
    acc[col] = index;
    return acc;
}, {});

// -- Uses Tesseract OCR to extract usernames/IDs from uploaded images
const extractUsernamesFromImage = async (message) => {
    if (!message.hasMedia) return [];
    const media = await message.downloadMedia();
    if (!media || !media.mimetype.startsWith('image/')) return [];

    try {
        const imageBuffer = Buffer.from(media.data, 'base64');

        const processedImageBuffer = await sharp(imageBuffer)
            .greyscale()
            .normalize()
            .sharpen()
            .toBuffer();

        const { data: { text } } = await Tesseract.recognize(
            processedImageBuffer,
            'eng'
        );

        const subscriberIdPattern = /\b\d{5}\b/g;
        let matches = text.match(subscriberIdPattern) || [];

        if (matches.length > 0) {
            console.log(`Found Subscriber ID(s): ${matches.join(', ')}`);
            return [...new Set(matches)];
        }

        const usernamePattern = /\b(jh\.[a-z0-9\._-]+)\b/gi;
        matches = text.match(usernamePattern) || [];

        if (matches.length > 0) {
            console.log(`Found Username(s): ${matches.join(', ')}`);
        }

        return [...new Set(matches.map(m => m.toLowerCase()))];

    } catch (error) {
        return [];
    }
};

// -- Helper Fuction End --

const sendTicketAlert = async (message) => {
    try {
        const chat = await client.getChatById(TICKET_MONITOR_CONFIG.TARGET_ID);
        await chat.sendMessage(message);
    } catch (error) {
    }
};

const replyToTicket = async (ticketId, content) => {
    try {
        const cookies = sessionCache;
        if (!cookies) throw new Error('No active session.');

        const form = new FormData();
        form.append('railwire_test_name', cookies.railwireCookie.value);
        form.append('ticketid', ticketId);
        form.append('content', content);

        const response = await axios.post('https://jh.railwire.co.in/crmcntl/bill_tickreply', form, {
            headers: {
                ...form.getHeaders(),
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        });

        return response.status === 200;
    } catch (error) {
        console.error(`Error replying to ticket #${ticketId}:`, error.message);
        return false;
    }
};

const handleTicketReply = async (message, ticketId, replyContent) => {
    const chat = await message.getChat();
    const success = await replyToTicket(ticketId, replyContent);

    if (success) {
        // Fetch and show the updated ticket to confirm
        const ticketViewUrl = `/crmcntl/billticketview/${ticketId}/0`;
        const updatedDetails = await getTicketDetails(ticketViewUrl, sessionCache);
        if (updatedDetails) {
            await chat.sendMessage(`✅ Reply sent! Here is the updated ticket:\n\n${formatTicketMessage(updatedDetails)}`);
        } else {
            await chat.sendMessage(`✅ Reply sent, but couldn't fetch the update.`);
        }
    } else {
        await chat.sendMessage(`❌ Failed to send reply to ticket #${ticketId}.`);
    }
};

const toTitleCase = (str) => {
    if (!str) return '';
    return str.trim()
        .split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
};

const normalize = (str) => str?.toString().trim().toLowerCase() || '';

const generateRandomMobile = () => {
    const randomDigits = Math.floor(100000000 + Math.random() * 900000000).toString();
    return `5${randomDigits}`;
};

const formatTicketMessage = (details) => {
    const timeOpenedParts = details.timeOpened.split(' on ');
    let openedDate = details.timeOpened;
    if (timeOpenedParts.length > 1) {
        openedDate = timeOpenedParts[1].split(' ').slice(1).join(' ');
    }

    let message = `*Ticket #${details.ticketId}:*\n\n` +
        `*Subscriber:* ${details.subscriberUsername}\n` +
        `*Customer No.:* ${details.customerMobile}\n` +
        `*Status:* ${details.status}\n` +
        `*Time opened:* ${openedDate}\n` +
        `*Subject:* ${details.subject}\n` +
        `*District:* ${details.district}\n` +
        `*Cluster:* ${details.cluster}\n` +
        `*Partner:* ${details.partnerName}\n`;

    if (details.messages.length > 0) {
        message += `\n`;
        
        const messageLines = details.messages.map(msg => {
            const timePart = (msg.timestamp.split(' on ')[0] || msg.timestamp).toLowerCase();
            const singleLineContent = msg.content.replace(/\r?\n|\r/g, ' ');
            return `*${timePart}* | *${msg.author}:* ${singleLineContent}`;
        });
        
        message += messageLines.join('\n\n'); 
    }

    return message.trim();
};

const getTicketDetails = async (ticketUrl, cookies) => {
    const { data } = await axios.get(`https://jh.railwire.co.in${ticketUrl}`, {
        headers: { 'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}` }
    });
    const $ = cheerio.load(data);

    const details = {};
    let subscriberUsername = '';

    $('table.table-bordered.table-striped.table-condensed').first().find('tbody tr').each((i, row) => {
        const key = $(row).find('td:first-child').text().trim().toLowerCase();
        const value = $(row).find('td:nth-child(2)').text().trim();
        
        if (key === 'ticket id') details.ticketId = value;
        if (key === 'subscriber') subscriberUsername = value;
        if (key === 'status') details.status = value;
        if (key === 'time opened') details.timeOpened = value;
    });

    if (!subscriberUsername) return null;
    details.subscriberUsername = subscriberUsername;

    const subjectContainer = $('.well.well-lg:contains("Subject :")');
    subjectContainer.find('span[style="float:right;"]').remove();
    details.subject = subjectContainer.text().replace('Subject :', '').trim();

    const portalUserData = await fetchUserDataFromPortal(subscriberUsername);
    details.customerMobile = portalUserData?.MobileNo || 'N/A';

    const cachedSubData = subscriberDataCache.get(normalize(subscriberUsername));
    details.district = cachedSubData?.['District'] || 'N/A';
    details.cluster = cachedSubData?.['Cluster'] || 'N/A';
    details.partnerName = cachedSubData?.['ANP Name'] || 'N/A';

    details.messages = [];
    $('h5.blue').each((i, authorElement) => {
        const author = $(authorElement).text().trim();
        const messageContainer = $(authorElement).parent('.col-xs-2').siblings('.col-xs-10');
        
        if (messageContainer.length > 0) {
            const timestamp = messageContainer.find('h6.header').text().trim();
            const content = messageContainer.find('.well').text().trim();

            if (author && timestamp && content) {
                details.messages.push({ author, timestamp, content });
            }
        }
    });

    return details;
};

const monitorAndAlertTickets = async (triggeredBy = 'cron') => {
    try {
        console.log(`Ticket monitoring started - Triggered by: ${triggeredBy}`);
        
        const cookies = sessionCache;
        const apiClient = axios.create({
            baseURL: 'https://jh.railwire.co.in',
            headers: { 'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}` }
        });

        const pageOffsets = ['', '30', '60', '90'];
        const ticketsToCheck = [];

        for (const offset of pageOffsets) {
            const url = `/crmcntl/bill_tickets${offset ? '/' + offset : ''}`;
            const response = await apiClient.get(url);
            const $ = cheerio.load(response.data);

            $('table#results tbody tr').each((i, row) => {
                const cells = $(row).find('td');
                const status = $(cells[7]).text().trim().toLowerCase();
                const subject = $(cells[4]).text().trim().toLowerCase();

                if (!ALLOWED_TICKET_SUBJECTS.has(subject)) {
                    return; // Skip non-allowed subjects
                }
                
                // We now check ALL 'open' or 'progress' tickets, not just new ones
                if (status === 'open' || status === 'progress') {
                    const ticketId = $(cells[0]).contents().first().text().trim();
                    const viewLink = $(cells[cells.length - 1]).find('a').attr('href');
                    if (ticketId && viewLink) {
                        ticketsToCheck.push({ ticketId, viewLink });
                    }
                }
            });
        }

        if (ticketsToCheck.length === 0) {
            console.log(`No "Open" or "Progress" tickets found for allowed subjects (${triggeredBy})`);
            return;
        }

        let changesFound = false;
        for (const ticket of ticketsToCheck) {
            const ticketDetails = await getTicketDetails(ticket.viewLink, cookies);
            
            if (ticketDetails) {
                // Handle missing cluster data
                if (!ticketDetails.cluster) {
                    console.log(`Skipping ticket #${ticket.ticketId} - No cluster data available`);
                    continue;
                }
                
                // Case-insensitive cluster check
                if (ticketDetails.cluster.toLowerCase() !== 'tatanagar') {
                    console.log(`Skipping ticket #${ticket.ticketId} - Cluster: ${ticketDetails.cluster}`);
                    continue;
                }
                
                const currentMessageCount = ticketDetails.messages.length;
                const lastKnownState = processedTicketsState[ticket.ticketId];

                // SCENARIO 1: Brand new ticket
                if (!lastKnownState) {
                    console.log(`New ticket found: #${ticket.ticketId} (${triggeredBy})`);
                    changesFound = true;
                    const formattedMessage = formatTicketMessage(ticketDetails);
                    await sendTicketAlert(formattedMessage);
                    processedTicketsState[ticket.ticketId] = { messageCount: currentMessageCount };
                    saveProcessedTicketsState(); // Save state immediately
                } 
                // SCENARIO 2: Existing ticket has a new reply
                else if (lastKnownState.messageCount < currentMessageCount) {
                    console.log(`Update found for ticket #${ticket.ticketId} (New message) - ${triggeredBy}`);
                    changesFound = true;
                    const formattedMessage = formatTicketMessage(ticketDetails);
                    await sendTicketAlert(formattedMessage);
                    processedTicketsState[ticket.ticketId].messageCount = currentMessageCount;
                    saveProcessedTicketsState(); // Save updated state
                }
            }
        }

        if (!changesFound) {
            console.log(`Checked ${ticketsToCheck.length} active tickets. No new messages or tickets found (${triggeredBy})`);
        }
    } catch (error) {
        console.error(`Error during ticket monitoring (${triggeredBy}):`, error.message);
    }
};

// -- This single function replaces all previous Excel loading functions --
const loadConsolidatedData = (filename = 'AllData.xlsx') => {
    // Re-initialize all caches to ensure fresh data
    subscriberDataCache = new Map();
    partnerLiveDetailsCache = {};
    partnerMappings = {};
    jhCodeMap = new Map();
    partnerIndex = new Map();
    partnerNameLookupCache = new Map(); // Initialize the new cache
    const portalUsersCache = new Map(); 

    try {
        const filePath = path.join(__dirname, filename);
        if (!fs.existsSync(filePath)) {
            console.error(`CRITICAL: Consolidated data file not found at ${filePath}`);
            return;
        }

        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);

        for (const row of rows) {
            const subscriberId = normalize(row['Subscriber ID']);
            const username = normalize(row['Username']);
            const anpId = normalize(row['ANP ID']);
            const anpName = normalize(row['ANP Name']);
            const jhCode = normalize(row['JH Code']);

            // --- VLOOKUP CACHE POPULATION ---
            // Create the lookup map keyed by Partner Name for filtering functions
            if (anpName && !partnerNameLookupCache.has(anpName)) {
                partnerNameLookupCache.set(anpName, {
                    'District': row['District'],
                    'Marketing Team': row['Marketing Team'],
                    'Marketing Team No.': row['Marketing Team No.']
                });
            }
            // ------------------------------------

            // 1. Populate subscriberDataCache and portalUsersCache
            if (username || subscriberId) {
                 const subscriberDetails = {
                    'Subscriber ID': row['Subscriber ID'],
                    'Username': row['Username'],
                    'Name': row['Subscriber Name'],
                    'MobileNo': row['Subscriber Mobile'],
                    'Email': row['Subscriber Email'],
                    'ANP ID': row['ANP ID'],
                    'ANP Name': row['ANP Name'],
                    'ANP Contact No': row['ANP Contact No'],
                    'District': row['District'],
                    'Cluster': row['Cluster'],
                    'Stack VLAN': row['Stack VLAN'],
                    'Customer VLAN': row['Customer VLAN'],
                    'JH Code': row['JH Code'],
                    'Subscriber Count': row['Subscriber Count'],
                    'Port': row['Primary Port'],
                    'Backup Port': row['Backup Port'],
                    'BNG': row['BNG'],
                    'Marketing Team': row['Marketing Team'],
                    'Marketing Team No.': row['Marketing Team No.'],
                    'Technical Team': row['Technical Team'],
                    'Technical Team No.': row['Technical Team No.']
                };
                
                if (subscriberId) {
                    subscriberDataCache.set(subscriberId, subscriberDetails);
                    portalUsersCache.set(subscriberId, subscriberDetails);
                }
                if (username) {
                    subscriberDataCache.set(username, subscriberDetails);
                    portalUsersCache.set(username, subscriberDetails);
                }
            }

            // 2. Populate partner-level caches (only once per partner)
            if (anpId && !partnerLiveDetailsCache[anpId]) {
                 partnerLiveDetailsCache[anpId] = {
                    'Partner ID': anpId,
                    'Partner Name': row['ANP Name'],
                    'ANP Contact No': row['ANP Contact No'],
                    'District': row['District'],
                    'Cluster': row['Cluster'],
                    'JH Code': row['JH Code'],
                    'Stack VLAN': row['Stack VLAN'],
                    'Customer VLAN': row['Customer VLAN'],
                    'Primary Port': row['Primary Port'],
                    'Backup Port': row['Backup Port'],
                    'BNG': row['BNG'],
                    'Marketing Team': row['Marketing Team'],
                    'Marketing Team No.': row['Marketing Team No.'],
                    'Technical Team': row['Technical Team'],
                    'Technical Team No.': row['Technical Team No.']
                };
            }
            
            if (jhCode && !partnerMappings[jhCode]) {
                partnerMappings[jhCode] = {
                    partnerId: anpId,
                    partnerName: anpName,
                };
            }

            if (anpName && jhCode && !jhCodeMap.has(normalize(anpName))) {
                 jhCodeMap.set(normalize(anpName), jhCode);

                const words = anpName.toLowerCase().split(' ');
                for (const word of words) {
                    if (word.length > 2) {
                        if (!partnerIndex.has(word)) {
                            partnerIndex.set(word, new Set());
                        }
                        partnerIndex.get(word).add(normalize(anpName));
                    }
                }
            }
        }
        
        userDataCacheByFile['AllData'] = portalUsersCache;
        console.log(`Successfully loaded consolidated data for ${subscriberDataCache.size} subscribers and ${Object.keys(partnerLiveDetailsCache).length} partners.`);

    } catch (err) {
        console.error(`Error reading consolidated data from Excel: ${err.message}`);
    }
};

const loadAllData = async () => {
    try {
        loadConsolidatedData(); 
    } catch (err) {
        console.error('Error loading consolidated data:', err.message);
    }
};


const getSubscriberCount = async () => {
    try {
        const cookies = sessionCache;
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        const dashboardUrl = 'https://jh.railwire.co.in/billcntl';

        const response = await axios.get(dashboardUrl, {
            headers: { 'Cookie': cookieString },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const subscriberCount = $('.infobox-content:contains("active subscribers")')
            .siblings('.infobox-data-number')
            .text()
            .trim();

        return subscriberCount || 'Count not found.';
    } catch (error) {
        console.error('Error fetching subscriber count after retries:', error.message);
        return 'Could not retrieve count.';
    }
};





const handleSubscriberUpdate = async (message) => {
    const chat = await message.getChat();
    try {
        await chat.sendMessage("Username or ID:");
        const idMessage = await waitForReply(message);
        const userCode = idMessage.body.trim();
        if (!userCode) {
            await chat.sendMessage("Canceled. No ID provided.");
            return;
        }
        const userDataMap = userDataCacheByFile['AllData'];
        const userData = userDataMap.get(normalize(userCode)) || await fetchUserDataFromPortal(userCode);

        if (!userData || !userData['Subscriber ID']) {
            await chat.sendMessage(`Could not find a subscriber with the ID "${userCode}". Please check and try again.`);
            return;
        }

        await chat.sendMessage(`Found: *${userData.Username}*\n\nInput New Phone Number:`);
        const phoneMessage = await waitForReply(message);
        const newPhoneNumber = phoneMessage.body.trim();
        if (!/^\d{10}$/.test(newPhoneNumber)) {
            await chat.sendMessage("Invalid phone number. Please enter a 10-digit number. Operation canceled.");
            return;
        }

        await chat.sendMessage(`Input New Email Address:`);
        const emailMessage = await waitForReply(message);
        const newEmail = emailMessage.body.trim().toLowerCase();
        if (!/\S+@\S+\.\S+/.test(newEmail)) {
            await chat.sendMessage("Invalid email format. Operation canceled.");
            return;
        }

        const cookies = sessionCache;
        const payload = new URLSearchParams({
            'cnumber': newPhoneNumber,
            'cemail': newEmail,
            'id': userData['Subscriber ID'],
            'railwire_test_name': cookies.railwireCookie.value
        });
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        };
        const response = await axios.post('https://jh.railwire.co.in/billcntl/resetsdetail', payload.toString(), config);
        const responseData = response.data;

        if (responseData && responseData.STATUS === "OK") {
            await chat.sendMessage(`Details have been updated successfully for *${userData.Username}*!`);
        } else {
            const serverStatus = responseData ? responseData.STATUS : "No response";
            await chat.sendMessage(`Update failed. Server responded: ${serverStatus}`);
        }

    } catch (error) {
        console.error("Error during subscriber update after retries:", error.message);
        await chat.sendMessage("An unexpected error occurred during the update process.");
    }
};


const handleBulkSubscriberUpdate = async (message) => {
    const chat = await message.getChat();
    const userIdentifier = getUserIdentifier(message);
    const session = userSessions.get(userIdentifier);

    if (!session || !session.userCodes || session.userCodes.length === 0) {
        await chat.sendMessage("No usernames or IDs found.\nPlease send a list of usernames/IDs first, then type `bulksubupdate`.");
        return;
    }
    const { userCodes } = session;

    for (const userCode of userCodes) {
        try {
            const userData = await fetchUserDataFromPortal(userCode);
            const subscriberId = userData['Subscriber ID'] || userData.SubscriberId;
            if (!subscriberId || !userData.Username) {
                await chat.sendMessage(`❌ Could not find subscriber: *${userCode}*. Skipping.`);
                continue;
            }

            const newPhoneNumber = generateRandomMobile();
            const newEmail = generateRandomEmail(userData.Username);

            const cookies = sessionCache;
            const payload = new URLSearchParams({
                'cnumber': newPhoneNumber,
                'cemail': newEmail,
                'id': userData['Subscriber ID'],
                'railwire_test_name': cookies.railwireCookie.value
            });
            const config = {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
                }
            };
            const response = await axios.post('https://jh.railwire.co.in/billcntl/resetsdetail', payload.toString(), config);
            const responseData = response.data;

            if (responseData && responseData.STATUS === "OK") {
            let reply = `*Username:* ${userData.Username}\n`;
                reply += `*Mobile No.:* ${newPhoneNumber}\n`;
                reply += `*Email ID:* ${newEmail}\n\n`;
                reply += `Details have been updated successfully.`;
                await chat.sendMessage(reply);
            } else {
                const serverStatus = responseData ? responseData.STATUS : "No response";
                await chat.sendMessage(`Update failed for *${userData.Username}*. Server responded: ${serverStatus}`);
            }
        } catch (error) {
            console.error(`Error during bulk update for ${userCode} after retries:`, error.message);
            await chat.sendMessage(`An error occurred while processing *${userCode}*.`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    userSessions.delete(userIdentifier);
    await chat.sendMessage("Bulk update process finished.");
};


const baseURL = 'https://jh.railwire.co.in';
const mainURL = `${baseURL}/billcntl/kycpending`;
let jhCodeMap = null;

const generateQRCode = (qr) => {
    console.log('Scan the QR code below to login:');
    qrcode.generate(qr, {
        small: true
    });
};

const authenticate = async (username, password) => {
    return retryOperation(async () => {
        let sessionCookies = {};
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
            const loginPageResponse = await axios.get(`${baseURL}/rlogin`, {
                timeout: 30000
            });
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
                headers: {
                    'Cookie': currentCookieHeader
                }
            })).data;
            const {
                data: {
                    text
                }
            } = await Tesseract.recognize(captchaImageBuffer, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            });
            const captchaText = text.replace(/[^A-Z0-9]/g, '');
            if (!captchaText) {
                throw new Error('Failed to solve CAPTCHA using Tesseract.');
            }

            // Step 3: Get the public key for password encryption
            const publicKeyResponse = await axios.get(`${baseURL}/rlogin/getPublicKey?token=${dynamicSaltToken}`, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': currentCookieHeader
                }
            });
            const publicKey = publicKeyResponse.data.publicKey;
            if (!publicKey) {
                throw new Error('Failed to retrieve public key.');
            }

            // Step 4: Encrypt the password using the public key and salt
            const encryptedPasswordBase64 = publicEncrypt({
                    key: publicKey,
                    padding: constants.RSA_PKCS1_PADDING
                },
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
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': currentCookieHeader
                },
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
                    railwireCookie: {
                        name: 'railwire_cookie_name',
                        value: railwireCookieValue
                    },
                    ciSessionCookie: {
                        name: 'ci_session',
                        value: ciSessionValue
                    }
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

const getNmsSessionFromPortal = async (portalCookies) => {
    try {
        // Step 1: Use portal cookies to get NMS credentials from the dashboard
        const billingCookieString = `${portalCookies.railwireCookie.name}=${portalCookies.railwireCookie.value}; ${portalCookies.ciSessionCookie.name}=${portalCookies.ciSessionCookie.value}`;
        
        const { data: nmsLoginPageData } = await axios.get(`${baseURL}/billcntl`, { 
            headers: { 'Cookie': billingCookieString },
            timeout: 15000
        });

        const $ = cheerio.load(nmsLoginPageData);
        const nmsUsername = $('#srvs_redi input[name="username"]').val();
        const nmsPassword = $('#srvs_redi input[name="password"]').val();
        const circle = $('#srvs_redi input[name="circle"]').val();

        if (!nmsUsername || !nmsPassword) {
            throw new Error("Could not extract NMS credentials from portal dashboard.");
        }

        console.log('Extracted NMS credentials, authenticating with NMS...');

        // Step 2: Authenticate with NMS using extracted credentials
        const nmsLoginResponse = await axios.post(
            `${ANP_CONFIG.SERVICES_URL}/services_rlogin.php`,
            new URLSearchParams({
                username: nmsUsername,
                password: nmsPassword,
                circle: circle || ''
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0,
                validateStatus: status => status === 302,
                timeout: 15000
            }
        );

        // Step 3: Extract session cookies from NMS response
        const setCookieHeaders = nmsLoginResponse.headers['set-cookie'];
        if (!setCookieHeaders || setCookieHeaders.length === 0) {
            throw new Error("NMS login failed - no session cookies received.");
        }

        // Parse and format NMS cookies
        const nmsCookie = setCookieHeaders
            .map(cookieString => cookieString.split(';')[0])
            .join('; ');

        console.log('NMS authentication successful!');
        return nmsCookie;

    } catch (error) {
        console.error('NMS authentication failed:', error.message);
        throw error;
    }
};

async function retryOperation(operation, maxRetries = 5, delay = 1000) { 
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            console.log(`Operation failed on attempt ${attempt}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}


async function fetchUserDataFromPortal(userCode) {
    try {
        const cookies = sessionCache;
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        const payload = new URLSearchParams({
            'railwire_test_name': cookies.railwireCookie.value,
            'user-search': userCode
        });

        const searchResponse = await axios.post(
            'https://jh.railwire.co.in/billcntl/searchsub ',
            payload.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieString,
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
        }
        );

        let finalUrl = searchResponse.headers.location;
        if (!finalUrl || !finalUrl.startsWith('/')) return null;
        finalUrl = `https://jh.railwire.co.in${finalUrl}`;

        const tableResponse = await axios.get(finalUrl, { headers: { Cookie: cookieString } });
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
            const detailResponse = await axios.get(userDetailUrl, { headers: { Cookie: cookieString } });
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
    } catch (error) {
        console.error(`Error fetching portal data for ${userCode} after retries:`, error.message);
        return null;
    }
}

const resetSession = async (userData) => {
    try {
        const cookies = sessionCache;
        const payload = `uname=${userData.Username}&railwire_test_name=${cookies.railwireCookie.value}`;
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        };
        const response = await axios.post('https://jh.railwire.co.in/billcntl/endacctsession', payload, config);
        const responseData = response.data;

        console.log(`Session reset response:`, responseData);
        if (responseData.message && responseData.message.includes('-1')) {
            return 'NOT_ACTIVE';
        } else if (responseData.STATUS === 'OK') {
            return 'SUCCESS';
        } else {
            return 'ERROR';
        }
    } catch (error) {
        console.error('Reset error after retries:', error.message);
        return 'ERROR';
    }
};

const DeactivateID = async (userData) => {
    try {
        const cookies = sessionCache;
        const subscriberId = userData['Subscriber ID'] || userData.SubscriberId;
        const payload = `subid=${subscriberId}&railwire_test_name=${cookies.railwireCookie.value}`;
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        };
        const response = await axios.post('https://jh.railwire.co.in/billcntl/update_expiry', payload, config);
        const responseData = response.data;
        console.log(`Account activated / deactivated status: ${responseData.STATUS}`);
        return responseData.STATUS === 'OK';
    } catch (error) {
        console.error('Deactivate error after retries:', error.message);
        return false;
    }
};

const resetPassword = async (userData) => {
    try {
        const cookies = sessionCache;
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        };
        const subscriberId = userData['Subscriber ID'] || userData.SubscriberId;
        const basePayload = `subid=${subscriberId}&mobileno=${userData.MobileNo}&railwire_test_name=${cookies.railwireCookie.value}`;
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
        console.error('Password reset error after retries:', error.message);
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
    const messageBody = message.body;

    const usernamePattern = /jh[\.\w]+/gi;
    const subscriberIdPattern = /\b\d{5,}\b/g;
    const packageIdPattern = /\b\d{3,6}\b/g;

    const usernames = messageBody.match(usernamePattern) || [];
    const subscriberIds = messageBody.match(subscriberIdPattern) || [];
    const potentialPackageIds = messageBody.match(packageIdPattern) || [];

    if (usernames.length === 0 && subscriberIds.length > 0) {
        return await chat.sendMessage("Please provide a username not a subscriber ID.");
    }
    if (usernames.length === 0) {
        return await chat.sendMessage("Username not found in the message. send like this: planchange jh.xyz.username 800829");
    }
    if (potentialPackageIds.length === 0) {
        return await chat.sendMessage("Please provide a 3 to 6-digit Package ID in your message.");
    }
    if (potentialPackageIds.length > 1) {
        return await chat.sendMessage("Please provide only one Package ID at a time to apply to all users.");
    }

    const desiredPkgId = potentialPackageIds[0];

    for (const username of usernames) {
        try {
            const cookies = sessionCache;
            const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
            const payload = new URLSearchParams({
                'railwire_test_name': cookies.railwireCookie.value,
                'user-search': username
            });
            const searchResponse = await axios.post(
                'https://jh.railwire.co.in/billcntl/searchsub ',
                payload.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieString },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            }
            );
            const finalUrl = `https://jh.railwire.co.in${searchResponse.headers.location}`;
            const tableResponse = await axios.get(finalUrl, { headers: { 'Cookie': cookieString } });
            const $ = cheerio.load(tableResponse.data);
            const searchResults = [];
            $('table.table-striped tbody tr').each(function () {
                const row = $(this);
                const foundUsername = row.find('td:nth-child(2) a').text().trim();
                const link = row.find('td:nth-child(2) a').attr('href');
                if (foundUsername && link) {
                    searchResults.push({ username: foundUsername, link });
                }
            });

            let formData;
            if (searchResults.length === 0) {
                formData = { error: `No user found for "${username}".` };
            } else {
                const selectedUser = searchResults.find(user => user.username.toLowerCase() === username.toLowerCase());
                if (!selectedUser) {
                    formData = { error: `No exact match for "${username}". Found ${searchResults.length} partial matches.` };
                } else {
                    const detailUrl = `https://jh.railwire.co.in${selectedUser.link}`;
                    const detailPage = await axios.get(detailUrl, { headers: { 'Cookie': cookieString } });
                    const $$ = cheerio.load(detailPage.data);
                    formData = {
                        subid: $$('#subid').val() || '',
                        status: $$('#status').val() || '',
                        oldpkgid: $$('#oldpackageid').val() || '',
                        verifyHidden: $$('#verifyHidden').val() || '',
                        pkgid: desiredPkgId,
                        username: selectedUser.username
                    };
                }
            }

            if (formData.error) {
                await chat.sendMessage(formData.error + " Skipping.");
                continue;
            }

            const planChanged = await ChangePlan(formData);
            if (planChanged) {
                await chat.sendMessage(`Plan changed successfully for *${formData.username}* to Package ID *${desiredPkgId}*!`);
            } else {
                await chat.sendMessage(`Failed to change plan for *${formData.username}*. Check package ID and try again.`);
            }
        } catch (error) {
            console.error(`Error processing plan change for ${username} after retries:`, error.message);
            await chat.sendMessage(`An error occurred while processing plan change for *${username}*.`);
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
        await chat.sendMessage("Invalid Complaint Number.");
        return;
    }

    // Step 2: Login to get UserId
    let loginResult;
    try {
        loginResult = await login();
    } catch (err) {
        await chat.sendMessage("Failed to authenticate with backend.");
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
            await chat.sendMessage(`No complaint found with number ${complaintNumber}`);
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
        await chat.sendMessage("Enter Partner Name or ID:");
        const searchTerm = (await waitForReply(message)).body.trim();
        if (!searchTerm) {
            await chat.sendMessage("❌ Canceled. No search term provided.");
            return;
        }

        const cookies = sessionCache;
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        const listUrl = `${baseURL}/billcntl/billpartners`;
        const listResponse = await axios.get(listUrl, { headers: { 'Cookie': cookieString } });
        const $ = cheerio.load(listResponse.data);
        let foundMatch = null;
        let multipleMatches = [];
        const normalizedSearch = normalize(searchTerm);
        $('table#dynamic-table tbody tr').each(function () {
            const row = $(this);
            const partnerId = normalize(row.find('td').eq(0).text());
            const companyName = normalize(row.find('td').eq(1).find('a').text());
            if (partnerId === normalizedSearch || companyName === normalizedSearch) {
                multipleMatches.push({
                    name: row.find('td').eq(1).find('a').text().trim(),
                    id: row.find('td').eq(0).text().trim(),
                    link: row.find('td').eq(1).find('a').attr('href')
                });
            }
        });

        if (multipleMatches.length === 0) {
            await chat.sendMessage(`No ANP found matching "${searchTerm}".`);
            return;
        }
        if (multipleMatches.length > 1) {
            await chat.sendMessage(`Found multiple ANPs. Please be more specific:\n- ${multipleMatches.map(m => m.name).join('\n- ')}`);
            return;
        }
        foundMatch = multipleMatches[0];

        const detailUrl = baseURL + foundMatch.link;
        const detailResponse = await axios.get(detailUrl, { headers: { 'Cookie': cookieString } });
        const $$ = cheerio.load(detailResponse.data);
        const scrapeValue = (label) => $$('.profile-info-name:contains("' + label + '")').next().find('span.editable').text().trim();
        const scrapeHidden = (id) => $$(`#${id}`).val()?.trim() || '';
        const scrapeHtml = (id) => $$(`#${id}`).html()?.trim() || '';
        let gstin_raw = ($$('.profile-info-name:contains("GSTIN No")').next().text().trim() || scrapeHidden("gstinval")).trim();
        let gstin = (gstin_raw.startsWith('undefined') || gstin_raw === "") ? " " : gstin_raw;

        const payloadData = {
            'railwire_test_name': cookies.railwireCookie.value,
            'partnerid': scrapeHidden('partnerid'), 'cname': scrapeValue("Company Name"), 'cregno': scrapeValue("Company Registration Number"),
            'caddress': scrapeHtml('caddress'), 'cmanager': scrapeValue("Contact Person"), 'agreementdate': scrapeValue("Railwire Agreement Date"),
            'agreementno': scrapeValue("Railwire Agreement No"), 'pancard': scrapeHidden('pancard'), 'bank_acholder': scrapeValue("Bank Account Holder Name"),
            'bank_actype': scrapeValue("Bank Account Type"), 'bank_name': scrapeHtml('bank_name'), 'bank_branch': scrapeHtml('bank_branch'),
            'bank_acno': scrapeValue("Bank Account No"), 'bank_ifsc': scrapeHidden('bank_ifsc'), 'gstin': gstin, 'sacno': scrapeValue("SAC No"),
            'ptype': scrapeHtml('ptype'), 'gst_status': scrapeHidden("gststatus1"), 'legalname': scrapeHidden("legalnameval"),
            'tradename': scrapeHidden("tradenameval"), 'ptnrattid': scrapeHtml('ptnrattid'), 'ptnrlang': scrapeHtml('ptnrlang'),
            'territory_name': scrapeHidden('territory_name'), 'ring': scrapeValue("Ring"), 'brasip': scrapeValue("BRAS IP"),
            'switchip': scrapeValue("Switch IP"), 'dropping': scrapeValue("Dropping"), 'interface': scrapeValue("Interface"),
            'port_number': scrapeValue("Port Number"), 'pop_name': scrapeValue("Pop Name"), 'pop_pincode': scrapeValue("Pop Pin Code"),
            'ngcomany': scrapeHidden('ngcomany'), 'brmobile': scrapeValue("Bank Registered Mobile No"), 'bremail': scrapeValue("Bank Registered Email ID"),
            'reject_remark': "", 'onlinesub': "0", 'taxpayertype': 0, 'loc_type': null, 'onrechargeatom': 0, 'bankcheck': '1', 'subonrechargerazorpay': 0
        };
        const match = foundMatch;

        await chat.sendMessage(`Found ANP: *${match.name}*\n\nInput New Mobile No.:`);
        const phoneMessage = await waitForReply(message);
        const newPhoneNumber = phoneMessage.body.trim();
        if (!/^\d{10}$/.test(newPhoneNumber)) {
            await chat.sendMessage("Invalid phone number. Operation canceled.");
            return;
        }

        await chat.sendMessage(`Input New Email ID:`);
        const emailMessage = await waitForReply(message);
        const newEmail = emailMessage.body.trim().toLowerCase();
        if (!/\S+@\S+\.\S+/.test(newEmail)) {
            await chat.sendMessage("Invalid email format. Operation canceled.");
            return;
        }

        await chat.sendMessage(`Everything correct? (yes/no)`);
        const bankReply = await waitForReply(message);
        const updateBankDetails = bankReply.body.trim().toLowerCase() === 'yes';

        const finalPayload = { ...payloadData, cnumber: newPhoneNumber, cemail: newEmail };
        if (updateBankDetails) {
            finalPayload.brmobile = newPhoneNumber;
            finalPayload.bremail = newEmail;
        }

        let confirmationMessage = `*Confirm Details*\n_Changes are highlighted in bold._\n\n*Partner ID:* ${finalPayload.partnerid}\n*Company Name:* ${finalPayload.cname}\n*Phone:* *${finalPayload.cnumber}*\n*Email Address:* *${finalPayload.cemail}*\n*Bank Mobile:* ${updateBankDetails ? `*${finalPayload.brmobile}*` : finalPayload.brmobile}\n*Bank Email:* ${updateBankDetails ? `*${finalPayload.bremail}*` : finalPayload.bremail}\n\nCorrect? Type *yes* to submit, or anything else to cancel.`;
        await chat.sendMessage(confirmationMessage);
        const finalConfirmation = await waitForReply(message);

        if (finalConfirmation.body.trim().toLowerCase() === 'yes') {
            const freshCookiesForUpdate = sessionCache;
            const updateUrl = `${baseURL}/billcntl/savepdetailbefore`;
            const response = await axios.post(updateUrl, new URLSearchParams(finalPayload), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': `${freshCookiesForUpdate.railwireCookie.name}=${freshCookiesForUpdate.railwireCookie.value}; ${freshCookiesForUpdate.ciSessionCookie.name}=${freshCookiesForUpdate.ciSessionCookie.value}`
                }
            });
            const updateResponse = response.data;

            if (updateResponse && (updateResponse.STATUS === "OK" || updateResponse.STATUS === "BANK VERIFIED")) {
                await chat.sendMessage(`ANP details updated successfully for *${match.name}*!`);
            } else {
                const errorMsg = updateResponse ? (updateResponse.MESSAGE || updateResponse.STATUS) : "Unknown error";
                await chat.sendMessage(`Update failed for *${match.name}*. Server response: ${errorMsg}`);
            }
        } else {
            await chat.sendMessage("Update canceled by user. No changes were made.");
        }
    } catch (error) {
        console.error("Error during ANP update after retries:", error.message);
        await chat.sendMessage("An unexpected error occurred during the ANP update process.");
    }
};

// New function to handle OTT complaints automatically
const processOTTComplaint = async (message, userIdentifier, serviceProvider) => {
    const {
        userCode
    } = userSessions.get(userIdentifier);
    const chat = await message.getChat();

    // Load OTT data
    const ottData = userDataCacheByFile['AllData'];
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
            }), {
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
        await chat.sendMessage("Do you want to send the request? Type *yes* or *no*.");

        const confirmMessage = await waitForReply(message);
        if (confirmMessage.body.trim().toLowerCase() !== 'yes') {
            await chat.sendMessage("Request canceled.");
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
            form, {
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
            ...Array.from({
                length: 7
            }).reduce((acc, _, i) => ({
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
            ajaxPayload, {
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
        const cookies = sessionCache;
        const client = axios.create({
            baseURL: 'https://jh.railwire.co.in',
            headers: {
                'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            withCredentials: true,
        });
        const pageOffsets = ['', '30', '60'];
        const tickets = [];
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
                    tickets.push({ ticketId: match[1], viewUrl: respondLink, status: statusText, subject: subjectText.toLowerCase() });
                }
            });
        }
        
        let closedCount = 0, skippedCount = 0;
        const closedTickets = [];
        if (tickets.length > 0) {
            let closed = 0, skipped = 0;
            const processed = [];
            const autoCloseSubjects = ['no connectivity', 'wireless network issue'];

            for (const ticket of tickets) {
                if (!['open', 'progress'].includes(ticket.status)) {
                    skipped++; continue;
                }
                const detailRes = await client.get(ticket.viewUrl);
                const $$ = cheerio.load(detailRes.data);
                let subscriberId = null;
                $$('table.table-bordered.table-striped.table-condensed tbody tr').each((i, row) => {
                    if ($$(row).find('td:first-child').text().trim().toLowerCase() === 'subscriber') {
                        subscriberId = $$(row).find('td:nth-child(2)').text().trim();
                    }
                });
                const shouldCheckSession = autoCloseSubjects.some(subject => ticket.subject.includes(subject));
                if (shouldCheckSession && subscriberId) {
                    const sessionStatus = await checkSessionStatus(subscriberId);
                    if (sessionStatus === 'Active') {
                        const closePayload = new URLSearchParams({ ticketid: ticket.ticketId, response: 'Dear customer, link has been restored.', railwire_test_name: cookies.railwireCookie.value });
                        const closeResponse = await client.post('/crmcntl/close_ticket', closePayload.toString());
                        if (closeResponse.status === 200) {
                            closed++;
                            processed.push({ ticketId: ticket.ticketId, subscriberId: subscriberId });
                        } else { skipped++; }
                    } else { skipped++; }
                } else { skipped++; }
            }
            closedCount = closed;
            skippedCount = skipped;
            closedTickets.push(...processed);
        }

        let ticketSummary = `🎯 *Ticket Processing Results*\n\n*📊 Summary:*\n\n✅ ${closedCount} Closed (Session Active)\n⏭️ ${skippedCount} Skipped (Various Reasons)\n\n`;
        if (closedTickets.length > 0) {
            ticketSummary += `*🔒 Closed (${closedTickets.length}):*\n`;
            for (const ticket of closedTickets) {
                ticketSummary += `#${ticket.ticketId} (${ticket.subscriberId})\n`;
            }
            ticketSummary += `\n`;
        }
        await chat.sendMessage(ticketSummary);
    } catch (error) {
        console.error('Error in handleTicketActivation after retries:', error);
        await chat.sendMessage(`Error processing tickets: ${error.message}`);
    }
};

// Helper function to check session status
async function checkSessionStatus(subscriberCode) {
    try {
        const cookies = sessionCache;
        const client = axios.create({
            baseURL: 'https://jh.railwire.co.in',
            headers: {
                'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            withCredentials: true,
        });
        const payload = new URLSearchParams({ railwire_test_name: cookies.railwireCookie.value, 'user-search': subscriberCode });
        const searchRes = await client.post('/billcntl/searchsub', payload.toString());
        const $ = cheerio.load(searchRes.data);
        const detailLink = $('a[href^="/billcntl/subscriptiondetail/"]').attr('href');
        if (!detailLink) throw new Error('Subscriber detail link not found');

        const detailPageRes = await client.get(detailLink);
        const $$ = cheerio.load(detailPageRes.data);
        const dataUsageLink = $$('a[href^="/billcntl/currentmonthdatause/"]').attr('href');
        if (!dataUsageLink) throw new Error('Data usage link not found');

        const usagePageRes = await client.get(dataUsageLink);
        const $$$ = cheerio.load(usagePageRes.data);
        const sessionActive = $$$('#cusdiscon_btn').length > 0;
        return sessionActive ? 'Active' : 'Not Active';
    } catch (err) {
        console.warn(`Session status check failed for ${subscriberCode} after retries:`, err.message);
        return 'Not Active';
    }
}

// Simplified Active Filter - REBUILT WITH LOGIC FROM MainForm.cs
const filterActiveSubscribers = async (message) => {
    const chat = await message.getChat();
    try {
        await chat.sendMessage("Enter FROM date (YYYY-MM-DD):");
        const fromDate = (await waitForReply(message)).body.trim();
        await chat.sendMessage("Enter TO date (YYYY-MM-DD):");
        const toDate = (await waitForReply(message)).body.trim();
        
        await chat.sendMessage("Downloading active report and processing...");
        
        const cookies = sessionCache;
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        
        // Set date range for active report
        await axios.post('https://jh.railwire.co.in/ajx_datatables/sub_activesearch', 
            new URLSearchParams({
                'partnerid': 'All',
                'railwire_test_name': cookies.railwireCookie.value,
                'st': fromDate,
                'ed': toDate
            }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieString,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        // Download CSV
        const response = await axios.get('https://jh.railwire.co.in/billcntl/activesubreport', {
            headers: { 'Cookie': cookieString },
            responseType: 'text'
        });

        // Parse CSV data
        const lines = response.data.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            await chat.sendMessage("No data found in the report.");
            return;
        }

        const headers = parseCSVLine(lines[0]);
        
        // Process and filter data
        const filteredData = [];
        let removedForBalance = 0;
        let removedForPackage = 0;
        const currentDate = new Date().toLocaleDateString('en-GB').replace(/\//g, '-'); // Formats as DD-MM-YYYY

        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            if (values.length < headers.length) continue;

            const row = {};
            headers.forEach((header, index) => {
                row[header.toLowerCase()] = values[index] || '';
            });

            const packageName = row.packagename || '';
            const balance = parseFloat(row.balance || '0');
            const partnerName = row.partnercompanyname || '';

            // --- FILTERING LOGIC FROM C# APP ---
            if (packageName.trim().toLowerCase() === PackageNameToFilterOut.toLowerCase()) {
                removedForPackage++;
                continue;
            }
            if (/\s+x\d+$/i.test(packageName)) {
                removedForPackage++;
                continue;
            }
            if (balance > 100) {
                removedForBalance++;
                continue;
            }
            // --- END OF FILTERING LOGIC ---

            // --- DATA ENRICHMENT (VLOOKUP) LOGIC FROM C# APP ---
            const partnerDetails = partnerNameLookupCache.get(normalize(partnerName));
            
            const cleanRow = {
                'Subscriber ID': row.subscriberid || '',
                'Username': row.username || '',
                'Status': row.status || '',
                'Registration Date': row.registrationdate || '',
                'Expiry': row.expiry || '',
                'Partner Name': partnerName,
                'Date': currentDate,
                'District': partnerDetails ? partnerDetails['District'] : '',
                'Marketing Team': partnerDetails ? partnerDetails['Marketing Team'] : '',
                'Marketing Team No.': partnerDetails ? partnerDetails['Marketing Team No.'] : '',
                'Mobile Number': row.mobileno || '',
                'Package Name': packageName,
                'Balance': row.balance || ''
            };
            // --- END OF ENRICHMENT LOGIC ---

            filteredData.push(cleanRow);
        }

        // Create summary
        const summary = `Active Filter Results:\n\n` +
                       `Total rows processed: ${lines.length - 1}\n` +
                       `Rows kept: ${filteredData.length}\n` +
                       `Removed (Balance > 100): ${removedForBalance}\n` +
                       `Removed (Package Filter): ${removedForPackage}`;

        await chat.sendMessage(summary);

        // Create and send CSV file
        if (filteredData.length > 0) {
            const csvContent = createActiveCSV(filteredData);
            const fileName = `${new Date().toISOString().split('T')[0]}_Active_Filtered.csv`;
            const filePath = path.join(__dirname, fileName);
            fs.writeFileSync(filePath, csvContent);
            
            const media = MessageMedia.fromFilePath(filePath);
            await chat.sendMessage(media, { caption: 'Filtered Active Subscribers' });
            
            setTimeout(() => {
                try { fs.unlinkSync(filePath); } catch {}
            }, 5000);
        }

    } catch (error) {
        console.error('Error in filterActiveSubscribers:', error.message);
        await chat.sendMessage("Error processing active filter: " + error.message);
    }
};

// Inactive Filter - REBUILT WITH LOGIC FROM MainForm.cs
const filterInactiveSubscribers = async (message) => {
    const chat = await message.getChat();
    try {
        await chat.sendMessage("Enter FROM date (YYYY-MM-DD):");
        const fromDate = (await waitForReply(message)).body.trim();
        await chat.sendMessage("Enter TO date (YYYY-MM-DD):");
        const toDate = (await waitForReply(message)).body.trim();
        
        await chat.sendMessage("Downloading inactive report and processing...");
        
        const cookies = sessionCache;
        const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
        
        await axios.get(`https://jh.railwire.co.in/billcntl/submngisub/${fromDate}/${toDate}/All`, {
            headers: {
                'Cookie': cookieString,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        const response = await axios.get('https://jh.railwire.co.in/billcntl/inactivesubreport', {
            headers: { 'Cookie': cookieString },
            responseType: 'text'
        });

        const lines = response.data.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            await chat.sendMessage("No data found in the report.");
            return;
        }

        const headers = parseCSVLine(lines[0]);

        const filteredData = [];
        let removedForPackage = 0;
        let removedForCurrentMonth = 0;
        
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth();
        const currentDate = new Date().toLocaleDateString('en-GB').replace(/\//g, '-'); // Formats as DD-MM-YYYY
        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            if (values.length < headers.length) continue;

            const row = {};
            headers.forEach((header, index) => {
                row[header.toLowerCase()] = values[index] || '';
            });

            const packageName = row.packagename || '';
            const partnerName = row.partnercompanyname || '';
            const regDate = row.registrationdate ? new Date(row.registrationdate) : null;

            // --- FILTERING LOGIC FROM C# APP ---
            if (packageName.trim().toLowerCase() === PackageNameToFilterOut.toLowerCase()) {
                removedForPackage++;
                continue;
            }
            if (/\s+x\d+$/i.test(packageName)) {
                removedForPackage++;
                continue;
            }
            if (regDate && regDate.getFullYear() === currentYear && regDate.getMonth() === currentMonth) {
                removedForCurrentMonth++;
                continue;
            }
            // --- END OF FILTERING LOGIC ---

            // --- DATA ENRICHMENT (VLOOKUP) LOGIC FROM C# APP ---
            const partnerDetails = partnerNameLookupCache.get(normalize(partnerName));

            const cleanRow = {
                'Subscriber ID': row.subscriberid || '',
                'Username': row.username || '',
                'Status': row.status || '',
                'Registration Date': row.registrationdate || '',
                'Expiry': row.expiry || '',
                'Partner Name': partnerName,
                'Mobile Number': row.mobileno || '',
                'Date': currentDate,
                'District': partnerDetails ? partnerDetails['District'] : '',
                'Marketing Team': partnerDetails ? partnerDetails['Marketing Team'] : '',
                'Marketing Team No.': partnerDetails ? partnerDetails['Marketing Team No.'] : ''
            };
            // --- END OF ENRICHMENT LOGIC ---

            filteredData.push(cleanRow);
        }

        // Create summary
        const summary = `Inactive Filter Results:\n\n` +
                       `Total rows processed: ${lines.length - 1}\n` +
                       `Rows kept: ${filteredData.length}\n` +
                       `Removed (Package Filter): ${removedForPackage}\n` +
                       `Removed (Current Month): ${removedForCurrentMonth}`;

        await chat.sendMessage(summary);

        // Create and send CSV file
        if (filteredData.length > 0) {
            const csvContent = createInactiveCSV(filteredData);
            const fileName = `${new Date().toISOString().split('T')[0]}_Inactive_Filtered.csv`;
            const filePath = path.join(__dirname, fileName);
            fs.writeFileSync(filePath, csvContent);
            
            const media = MessageMedia.fromFilePath(filePath);
            await chat.sendMessage(media, { caption: 'Filtered Inactive Subscribers' });
            
            setTimeout(() => {
                try { fs.unlinkSync(filePath); } catch {}
            }, 5000);
        }

    } catch (error) {
        console.error('Error in filterInactiveSubscribers:', error.message);
        await chat.sendMessage("Error processing inactive filter: " + error.message);
    }
};

// --- AFTER (FIXED) ---
const createActiveCSV = (data) => {
    const headers = [
        'Subscriber ID', 'Username', 'Status', 'Registration Date', 'Partner Name', 'Expiry', 'Date',
        'District', 'Marketing Team', 'Marketing Team No.', 'Mobile Number', 'Package Name',
        'Balance', 'Conversation Remark', 'Final Remark'
    ];
    
    let csv = headers.join(',') + '\n';
    data.forEach(row => {
        const values = headers.map(header => {
            // Convert value to string BEFORE using .includes()
            const stringValue = (row[header] || '').toString(); 
            return stringValue.includes(',') ? `"${stringValue}"` : stringValue;
        });
        csv += values.join(',') + '\n';
    });
    
    return csv;
};

// --- AFTER (FIXED) ---
const createInactiveCSV = (data) => {
    const headers = [
        'Subscriber ID', 'Username', 'Status', 'Registration Date', 'Partner Name', 'Expiry',
        'Date', 'District', 'Marketing Team', 'Marketing Team No.', 'Mobile Number',
        'Conversation Remark', 'Final Remark'
    ];
    
    let csv = headers.join(',') + '\n';
    data.forEach(row => {
        const values = headers.map(header => {
            // Convert value to string BEFORE using .includes()
            const stringValue = (row[header] || '').toString();
            return stringValue.includes(',') ? `"${stringValue}"` : stringValue;
        });
        csv += values.join(',') + '\n';
    });
    
    return csv;
};

async function ChangePlan(formData) {
    try {
        const cookies = sessionCache;
        const url = 'https://jh.railwire.co.in/finapis/msp_plan_applynow';
        const payload = {
            verifyHidden: formData.verifyHidden,
            subid: formData.subid,
            pkgid: formData.pkgid,
            status: formData.status,
            uname: formData.username,
            oldpkgid: formData.oldpkgid,
            railwire_test_name: cookies.railwireCookie.value
        };
        const response = await axios.post(url, new URLSearchParams(payload).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
            }
        });
        const responseData = response.data;
        console.log(`Plan changed : "${responseData.STATUS}"`);
        return responseData.STATUS === 'OK';
    } catch (error) {
        console.error('\n❌ Error changing plan after retries:', error.message);
        return false;
    }
}

const processActions = async (message, userIdentifier, wantsSessionReset, wantsPasswordReset, wantsActivateID, wantsDeactivateID) => {
    const session = userSessions.get(userIdentifier);
    if (!session || !session.userCodes || !session.userCodes.length === 0) {
        userSessions.delete(userIdentifier);
        return;
    }

    const { userCodes } = session;
    const userDataMap = userDataCacheByFile['AllData'];

    for (const userCode of userCodes) {
        try {
            let fetchedUserData = userDataMap.get(userCode) || await fetchUserDataFromPortal(userCode);
            if (fetchedUserData) {
                let passwordResetResult = null;
                const maskedName = maskName(toTitleCase(fetchedUserData.Name));
                const maskedId = maskUsername(userCode);
                let responseMessage = `*Name:* ${maskedName}\n*ID:* ${maskedId}`;

                if (wantsSessionReset) {
                    console.log(`Requested Session Cleaning for ${userCode}...`);
                    const sessionStatus = await resetSession(fetchedUserData);
                    if (sessionStatus === 'SUCCESS') responseMessage += '\n*Session clear kr diya gya h* ✅';
                    else if (sessionStatus === 'NOT_ACTIVE') responseMessage += '\nSession active nhi hai ❌';
                    else responseMessage += '\nFailed to reset session ❌';
                }
                if (wantsActivateID) {
                console.log(`Activating ID for ${userCode}...`);
                const result = await DeactivateID(fetchedUserData);
                responseMessage += '\n' + (result ? '*Subscriber activated* ✅' : 'Failed to activate ❌');
                }

                if (wantsDeactivateID) {
                console.log(`Deactivating ID for ${userCode}...`);
                const result = await DeactivateID(fetchedUserData);
                responseMessage += '\n' + (result ? '*Subscriber deactivated* ✅' : 'Failed to deactivate ❌');
                }
                if (wantsPasswordReset) {
                    console.log(`Requested Password Resetting for ${userCode}...`);
                    passwordResetResult = await resetPassword(fetchedUserData);
                    if (passwordResetResult.portalReset && passwordResetResult.pppoeReset) responseMessage += '\n*Reset kr diya gya hai* ✅';
                    else responseMessage += '\nPassword reset failed';
                }
                await message.reply(responseMessage);
            } else {
                await message.reply(`Sahi ID btaye yeh galat h: ${userCode}`);
            }
        } catch (error) {
            console.error(`CRITICAL ERROR processing ${userCode}:`, error.message);
            await message.reply(`Could not process *${userCode}*. The server is not responding. Please try again later.`);
        }
    }
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



const processInBatches = async (items, asyncFn, batchSize = 15) => {
    let results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batchItems = items.slice(i, i + batchSize);
        const batchPromises = batchItems.map(item => asyncFn(item));
        const batchResults = await Promise.all(batchPromises);
        results = results.concat(batchResults);
    }
    return results;
};

const runAnpStatusCheckAndNotify = async (triggeredBy = 'cron') => {
    const startTime = new Date();
    const timeStamp = startTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`\nTriggered by: ${triggeredBy} | Time: ${timeStamp}`);

    if (!sessionCache || !nmsSessionCache) {
        console.error('ANP Check failed: Authentication session is not available.');
        return;
    }
    try {
        const authData = { ...sessionCache, nmsCookie: nmsSessionCache };

        if (!authData.nmsCookie) {
            throw new Error('Could not obtain NMS session');
        }

        console.log(`Fetching all partners...`);
        const allPartners = await getAllPartners(authData);
        console.log(`Found ${allPartners.length} total partners`);
        
        const partnersToCheck = allPartners.filter(p => p.total_subs > 0);
        console.log(`Checking ${partnersToCheck.length} partners with subscribers...`);

        const checkPartnerStatus = async (partner) => {
            const liveCount = await getLiveOnlineCount(partner.id, authData.nmsCookie);
            const status = liveCount === 'Error' ? 'ERROR' : liveCount === 0 ? 'DOWN' : 'OK';
            console.log(`${partner.name} | Online Users: ${liveCount} / ${partner.total_subs} | Status: ${status}`);
            return { ...partner, live_subs: liveCount };
        };
        
        const partnerResults = await processInBatches(partnersToCheck, checkPartnerStatus);

        const extraDetails = partnerLiveDetailsCache;
        const currentProblemPartners = new Map();
        const recoveredPartners = [];

        for (const p of partnerResults) {
            const isDown = p.live_subs === 'Error' || p.live_subs === 0;
            if (isDown) {
                currentProblemPartners.set(p.id, p);
            } else if (downPartnersState.has(p.id)) {
                recoveredPartners.push(downPartnersState.get(p.id).details);
                downPartnersState.delete(p.id);
                saveAnpDownState(); // Save state after a partner recovers
            }
        }

        const newAlerts = [];
        const amansStillDownPartners = []; // Use a new list for the filtered report
        const reportable = [...currentProblemPartners.values()].filter(p => !ANP_CONFIG.IGNORED_PARTNER_IDS.has(p.id));

        for (const p of reportable) {
            if (downPartnersState.has(p.id)) {
                // This is a "still down" partner. Check its district.
                const details = extraDetails[p.id] || {};
                const district = details['District'];
                if (district && ANP_CONFIG.AMAN_DISTRICTS.has(district)) {
                    amansStillDownPartners.push(`- *${p.name}* (Subs: ${p.live_subs} / ${p.total_subs})`);
                }
            } else {
                // This is a new partner going down
                downPartnersState.set(p.id, { firstSeen: Date.now(), details: p });
                saveAnpDownState();
                newAlerts.push(p);
            }
        }

        if (recoveredPartners.length > 0) {
            for (const recoveredPartner of recoveredPartners) {
                const details = extraDetails[recoveredPartner.id] || {};
                const upMessage = `*Detected: Partner-Link Up 🎉*\n\n✅ *${recoveredPartner.name}*`;
                await sendAnpAlert(upMessage, details);
            }
        }
        
        if (amansStillDownPartners.length > 0) {
            const NINETY_MINUTES_MS = 90 * 60 * 1000;
            if (Date.now() - lastStillDownReportTime >= NINETY_MINUTES_MS) {
                // Build the custom message and send it directly to Aman
                let summaryMessage = "*Aman's Still down ANPs :*\n\n";
                summaryMessage += amansStillDownPartners.join('\n');
                await client.sendMessage(ANP_CONFIG.AMAN_TARGET_ID, summaryMessage);
                
                lastStillDownReportTime = Date.now();
                saveAnpReportState();
            }
        }

        if (newAlerts.length > 0) {
            newAlerts.sort((a, b) => a.name.localeCompare(b.name));
            for (const p of newAlerts) {
                const details = extraDetails[p.id] || {};
                const liveSubsDisplay = p.live_subs === 'Error' ? 'ERROR' : p.live_subs;
                let msg = `*Detected: Partner Link-Down 🎟️*\n\n` +
                `*Name:* ${p.name}\n` +
                `*District:* ${details['District'] || 'Not Found'}\n` +
                `*Subscriber:* ${liveSubsDisplay} / ${p.total_subs}\n\n` +
                `*ANP Contact:* ${details['ANP Contact No'] || 'Not Found'}\n` +
                `*Tech Contact:* ${details['Technical Team No.'] || 'Not Found'} (${details['Technical Team'] || 'N/A'})\n\n` +
                `*VLAN (S/C):* ${details['Stack VLAN'] || 'Not Found'} / ${details['Customer VLAN'] || 'Not Found'}\n` +
                `*JH Code:* ${details['JH Code'] || 'Not Found'}\n` +
                `*Port:* ${details['Primary Port'] || 'Not Found'}\n` +
                `*BNG:* ${details['BNG'] || 'Not Found'}`;
                
                await sendAnpAlert(msg, details); 
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        if (!recoveredPartners.length && !amansStillDownPartners.length && !newAlerts.length) {
            console.log(`✅ All partners healthy - no issues detected`);
        }
        
        const endTime = new Date();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`\nTotal duration: ${duration} seconds | Completed: ${endTime.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })}\n`);
    } catch (error) {
        console.error(`\nANP Check CRITICAL ERROR after retries: ${error.message}`);
    }
};

const getAllPartners = async (authData) => {
    const billingCookieString = `${authData.railwireCookie.name}=${authData.railwireCookie.value}; ${authData.ciSessionCookie.name}=${authData.ciSessionCookie.value}`;
    const { data } = await retryOperation(() => axios.get(`${baseURL}/billcntl/all_sms_foranp/1/-2FBCY7HQ5jGnbqMTZmz1NxqNq9xb9oTXb-1tLVyjeg=`, { headers: { 'Cookie': billingCookieString, 'Referer': `${baseURL}/billcntl/all_sms_templates` } }));

    const $ = cheerio.load(data);
    const partners = [];
    $('table tbody tr').each((i, elem) => {
        const tds = $(elem).find('td');
        if (tds.length < 4) return;
        const partnerId = $(tds[0]).find('input').val();
        const partnerName = $(tds[2]).text().trim();
        const totalSubs = parseInt($(tds[3]).text().trim(), 10);
        if (partnerId && partnerName && !isNaN(totalSubs)) partners.push({ id: partnerId, name: partnerName, total_subs: totalSubs });
    });
    if (partners.length === 0) throw new Error("ANP Checker: Could not find any partners.");
    return partners;
};

const getLiveOnlineCount = async (partnerId, nmsCookie) => {
    try {
        const { data } = await retryOperation(() => axios.post(`${ANP_CONFIG.SERVICES_URL}/dash.php`, new URLSearchParams({ 'search1': 'search', 'ptnr': partnerId }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': nmsCookie, 'Referer': `${ANP_CONFIG.SERVICES_URL}/dash.php` }, timeout: 15000 }));

        const match = data.match(/Online Users.*?<div class="value">(\d+)<\/div>/s);
        return match ? parseInt(match[1], 10) : null;
    } catch (error) {
        console.error(`ANP Checker: Failed to get live count for ${partnerId} after multiple retries: ${error.message}`);
        return 'Error';
    }
};



const handleIncomingMessage = async (message) => {
    try {
        const chat = await message.getChat();
        const ignoredGroupNames = ['Railtel & MSP team Jharkhand', 'Railwire - Dhanbad Zone'];
        if (chat.isGroup && ignoredGroupNames.includes(chat.name)) {
            return;
        }

        const userIdentifier = getUserIdentifier(message);
        const rawBody = message.body; 
        const lowerCaseBody = rawBody.toLowerCase();

        console.log(`User Detail: ${userIdentifier}`);
        console.log(`Message: ${rawBody}`);

        const replyMatch = rawBody.match(/^\$(\d{7,})\s+(.+)/s);
        if (replyMatch) {
        const ticketId = replyMatch[1];
        const replyContent = replyMatch[2];
        await handleTicketReply(message, ticketId, replyContent);
        return; // Important: stops the rest of the function
        }


        const SESSION_TIMEOUT_MS = 300000;
        const EXECUTION_DELAY_MS = 1300;

        const codePattern = /jh(\s*\.\s*\w+){2,}/gi;
        const subscriberIdPattern = /(?<!\d)\b\d{5}\b(?!\d)/g;

        const codesFromText = (rawBody.match(codePattern) || []).concat(rawBody.match(subscriberIdPattern) || []);
        const codesFromImage = await extractUsernamesFromImage(message);

        const codesInThisMessage = [...new Set([...codesFromText, ...codesFromImage])]
            .map(c => c.toLowerCase().replace(/\s/g, ''));

        const wantsSessionReset = /\b(season|session|mac)\b/i.test(lowerCaseBody);
        const wantsActivateID = /\b(reactive|reactivate|re-active|re-activated)\b/i.test(lowerCaseBody);
        const wantsPasswordReset = /\b(reset|risat|resat|re-set|resert|resate|risit|rest|reser|riset)\b/i.test(lowerCaseBody);
        const wantsDeactivateID = /\b(deactivate|deactive|de-activate)\b/i.test(lowerCaseBody);

        let serviceProvider = null;
        if (/\b(hotstar|jiohotstar)\b/i.test(lowerCaseBody)) serviceProvider = 'Hotstar_Super';
        else if (/\b(sony|sonyliv)\b/i.test(lowerCaseBody)) serviceProvider = 'SonyPremium';
        else if (/\b(zee5|zee|zee-5)\b/i.test(lowerCaseBody)) serviceProvider = 'ZEE5';

        const existingSession = userSessions.get(userIdentifier) || { userCodes: [], pendingActions: {} };

        if (existingSession.abandonmentTimeoutId) clearTimeout(existingSession.abandonmentTimeoutId);

        const combinedUserCodes = [...new Set([...existingSession.userCodes, ...codesInThisMessage])];
        const combinedActions = { ...existingSession.pendingActions };
        if (wantsSessionReset) combinedActions.wantsSessionReset = true;
        if (wantsActivateID) combinedActions.wantsActivateID = true;
        if (wantsDeactivateID) combinedActions.wantsDeactivateID = true;
        if (wantsPasswordReset) combinedActions.wantsPasswordReset = true;
        if (serviceProvider) combinedActions.serviceProvider = serviceProvider;

        const hasData = combinedUserCodes.length > 0;
        const hasAction = Object.keys(combinedActions).length > 0;

        const updatedSession = {
            ...existingSession,
            userCodes: combinedUserCodes,
            pendingActions: combinedActions,
            lastUpdated: Date.now()
        };
        userSessions.set(userIdentifier, updatedSession);

        if (hasData && hasAction) {
            if (updatedSession.executionTimeoutId) clearTimeout(updatedSession.executionTimeoutId);

            const newExecutionTimeoutId = setTimeout(() => {
                const sessionToProcess = userSessions.get(userIdentifier);
                if (!sessionToProcess) return;

                if (sessionToProcess.pendingActions.serviceProvider) {
                    userSessions.set(userIdentifier, { ...sessionToProcess, userCode: sessionToProcess.userCodes[0] });
                    processOTTComplaint(message, userIdentifier, sessionToProcess.pendingActions.serviceProvider);
                } else {
                    processActions(message, userIdentifier,
                        sessionToProcess.pendingActions.wantsSessionReset,
                        sessionToProcess.pendingActions.wantsPasswordReset,
                        sessionToProcess.pendingActions.wantsActivateID,
                        sessionToProcess.pendingActions.wantsDeactivateID
                    );
                }
            }, EXECUTION_DELAY_MS);

            updatedSession.executionTimeoutId = newExecutionTimeoutId;

        } else {
            updatedSession.abandonmentTimeoutId = setTimeout(() => userSessions.delete(userIdentifier), SESSION_TIMEOUT_MS);
        }

        const messageBodyNoSpaces = rawBody.replace(/\s/g, '').toLowerCase();

        if (messageBodyNoSpaces.includes('subscount') || messageBodyNoSpaces.includes('subscribercount')) {
            const count = await getSubscriberCount();
            const formattedTime = new Date().toLocaleTimeString('en-US');
            const replyMessage = `*Time:* ${formattedTime}\n*Active Subscriber:* *${count}*\nTo check anytime type: *subscount*`;
            await message.reply(replyMessage);
            return;
        }

        if (lowerCaseBody.startsWith('search ')) {
            const searchTerm = rawBody.substring(7).trim();
            await handleSubscriberSearch(message, searchTerm);
            return;
        }
        
        if (messageBodyNoSpaces.includes('anpcheck') || messageBodyNoSpaces.includes('apncheck')) {
            await message.reply('ANP Status Check Started...');
            try {
                await runAnpStatusCheckAndNotify(false, 'manual');
                await message.reply('ANP Status Check Completed');
            } catch (error) {
                console.error('Manual ANP check failed:', error.message);
                await message.reply('ANP Status Check Failed');
            }
            return;
        }
        
        if (messageBodyNoSpaces.includes('anpupdate')) {
            await handleAnpUpdate(message);
            return;
        }

        // Add these to your handleIncomingMessage function:
        if (messageBodyNoSpaces.includes('activefilter')) {
        await filterActiveSubscribers(message);
        return;
        }

        if (messageBodyNoSpaces.includes('grabfilter')) {
        await filterInactiveSubscribers(message);
        return;
        }

        if (messageBodyNoSpaces.includes('checktickets')) {
            await message.reply('Manually checking for Tickets...');
            await monitorAndAlertTickets('manual');
            await message.reply('Ticket check complete.');
            return;
        }

        if (messageBodyNoSpaces.includes('subschange')) {
            await handleSubscriberUpdate(message);
            return;
        }

        if (messageBodyNoSpaces.includes('bulksubupdate')) {
            await handleBulkSubscriberUpdate(message);
            return;
        }

        if (messageBodyNoSpaces.includes('validateticket')) {
            await handleTicketActivation(message);
            return;
        }

        if (messageBodyNoSpaces.includes('checkott')) {
            await checkComplaintStatus(message);
            return;
        }

        if (messageBodyNoSpaces.includes('slastart')) {
            await createSLATicket(message);
            return;
        }
        
        if (messageBodyNoSpaces.includes('planchange') || messageBodyNoSpaces.includes('planupdate')) {
            await handlePlanChange(message);
            return;
        }

        if (messageBodyNoSpaces.includes('cafupdate')) {
            await message.reply('eKYC Checking..');
            try {
                const cookies = sessionCache;
                const totalProcessed = await processAllForms(cookies, message);
                await message.reply(`Completed: ${totalProcessed}`);
            } catch (authError) {
                console.error('Authentication failed before CAF update:', authError.message);
                await message.reply('Could not start eKYC process. Authentication failed.');
            }
        }
    } catch (error) {
        try {
        } catch (replyError) {
            console.error('Failed to send the error reply to the user:', replyError);
        }
    }
};

client.on('ready', async () => {

    // --- 1. Initial Data Loading ---

    loadProcessedTicketsState(); 
    loadAnpDownState();
    loadAnpReportState();
    loadAllData();
    botStartTime = Date.now();

    // --- 2. Define Authentication Refresh Logic ---
    const AUTH_LIFETIME = 282000; // 4 minutes 42 seconds

    const forceRefreshSession = async () => {
        try {
            const freshPortalSession = await authenticate('admin', 'Pass@123');
            const freshNmsCookie = await getNmsSessionFromPortal(freshPortalSession);
            sessionCache = freshPortalSession;
            nmsSessionCache = freshNmsCookie;
            console.log('Bot is healthy.');
        } catch (err) {
            console.error('[TIMER] FAILURE: Proactive session refresh failed:', err.message);
            sessionCache = null;
            nmsSessionCache = null;
            const recoveryDelay = 15000; // 15 seconds
            console.error(`Scheduling recovery attempt in ${recoveryDelay / 1000} seconds.`);
            setTimeout(forceRefreshSession, recoveryDelay);
            throw err;
        }
    };

    // --- 3. Perform Initial Authentication and Setup Scheduled Tasks ---
    const initialDelay = 3000; // 3 seconds
    try {
        await new Promise(resolve => setTimeout(resolve, initialDelay));
        await forceRefreshSession();
        console.log('Bot is fully operational.');
        const scheduledTask = async () => {
            try {
                const count = await getSubscriberCount();
            //    const message = `*Time:* ${new Date().toLocaleTimeString('en-US')}\n*Active Subscriber:* *${count || 'N/A'}*\n\nFinal count and report for the day.`;
                const greeting = new Date().getHours() < 12 ? 'Morning report of the day.' : 'Final count and report for the day.';
                const message = `*Time:* ${new Date().toLocaleTimeString('en-US')}\n*Active Subscriber:* *${count || 'N/A'}*\n\n${greeting}`;
                const targetIds = ['917004501523@c.us', '916200493605@c.us'];
                let csvMedia = null;
                try {
                    const cookies = sessionCache;
                    const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
                    const response = await axios.get('https://jh.railwire.co.in/billcntl/report/csv', {
                        headers: {
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Cookie': cookieString,
                            'Sec-Fetch-Dest': 'document',
                        },
                        responseType: 'arraybuffer'
                    });
                    if (response.status !== 200) { throw new Error(`Server responded with status ${response.status}`); }
                    const csvBuffer = response.data;
                    const today = new Date();
                    const fileName = `Subscriber_Report_${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.csv`;
                    const filePath = path.join(__dirname, fileName);
                    fs.writeFileSync(filePath, csvBuffer);
                    csvMedia = MessageMedia.fromFilePath(filePath);
                    console.log('CSV downloaded and prepared for distribution');
                } catch (error) {
                    console.error('Error downloading CSV after retries:', error.message);
                }
                for (const id of targetIds) {
                    try {
                        const chat = await client.getChatById(id);
                        await chat.sendMessage(message);
                        if (csvMedia) {
                            await chat.sendMessage(csvMedia, { caption: 'Daily Subscriber Report' });
                        } else {
                            await chat.sendMessage('Failed to download the daily subscriber report.');
                        }
                    } catch (err) {
                        console.error(`Failed to send report to ID ${id}:`, err.message);
                    }
                }
                if (csvMedia) {
                    try {
                        const today = new Date();
                        const fileName = `Subscriber_Report_${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.csv`;
                        const filePath = path.join(__dirname, fileName);
                        fs.unlinkSync(filePath);
                        console.log('Temporary CSV file cleaned up');
                    } catch (cleanupError) {
                        console.error('Error cleaning up CSV file:', cleanupError.message);
                    }
                }
            } catch (error) {
                console.error('Scheduled daily task failed:', error.message);
            }
        };

        cron.schedule('0 9 * * *', scheduledTask, { timezone: "Asia/Kolkata" });
        cron.schedule('59 23 * * *', scheduledTask, { timezone: "Asia/Kolkata" });

        // ANP Status Check Task
        cron.schedule('*/6 * * * *', runAnpStatusCheckAndNotify, { timezone: "Asia/Kolkata" });

        // Ticket Monitoring Task
        cron.schedule(TICKET_MONITOR_CONFIG.CRON_SCHEDULE, monitorAndAlertTickets, { timezone: "Asia/Kolkata" });

        // Finally, start the main proactive refresh timer for subsequent runs
        setInterval(forceRefreshSession, AUTH_LIFETIME);

        console.log('WhatsApp bot ready to use!!');

    } catch (error) {
        console.error('CRITICAL: Initial authentication failed. The bot may not function correctly until the first recovery attempt succeeds.', error.message);
    }
});

client.on('qr', generateQRCode);

client.on('message', (message) => {
    if (message.timestamp * 1000 < botStartTime) {
        return;
    }

    handleIncomingMessage(message);
});


client.initialize();