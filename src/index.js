const request = require("request");
const cheerio = require("cheerio");
const moment = require("moment");

const j = request.jar();
const {
    BaseKonnector,
    saveBills,
    log,
    errors
} = require("cozy-konnector-libs");

const logger = {
    info: msg => log("info", msg),
    error: msg => log("error", msg)
};

const baseURL = "https://www.materiel.net/";

const billsTableSelector = "#ListCmd table";

module.exports = new BaseKonnector(start);

async function start(fields) {
    const html = await login(fields);
    const bills = parsePage(html);
    await saveBills(bills, fields.folderPath, {
        identifiers: ["materiel.net"]
    });
}

/**
 * @param {string} html
 * @return cheerio[]
 */
function extractBillsRows(html) {
    const $ = cheerio.load(html);
    const container = $(billsTableSelector);
    return container
        .find("tr[data-order]")
        .toArray()
        .map(r => $(r));
}

function fetchBillPageBillsList(options, cb) {
    request(options, (err, res, body) => {
        if (err) {
            logger.info(`Could not fetch bills list from ${options.url}`);
            return cb(null);
        }

        cb(extractBillsRows(body));
    });
}

// Login layer
function login(requiredFields) {
    return new Promise((resolve, reject) => {
        const signInOptions = {
            method: "POST",
            ecdhCurve: "auto",
            jar: j,
            url: `${baseURL}pm/client/logincheck.nt.html`,
            form: {
                identifier: requiredFields.login,
                credentials: requiredFields.password,
                back: ""
            }
        };

        const billsOptions = {
            method: "GET",
            ecdhCurve: "auto",
            jar: j,
            url: `${baseURL}pm/client/commande.html`
        };

        logger.info("Signing in");
        request(signInOptions, (err, res) => {
            if (err || res.headers.location.match(/login.html/)) {
                logger.error("Signin failed");
                return reject(new Error(errors.LOGIN_FAILED));
            }

            if (res.headers.location.indexOf("captcha") !== -1) {
                logger.error("Hit captcha webpage");
                return reject(new Error(errors.CHALLENGE_ASKED));
            }

            // Download bill information page.
            logger.info("Fetching bills list");
            request(billsOptions, (err, res, body) => {
                if (err) {
                    logger.error("An error occured while fetching bills list");
                    return reject(new Error(errors.UNKNOWN_ERROR));
                }

                // Check if there are several pages
                const $ = cheerio.load(body);
                const commandList = $("#ListCmd");

                if (!commandList.length) {
                    logger.error(
                        "Could not parse page (did not find expected id)"
                    );
                    return reject(new Error(errors.UNKNOWN_ERROR));
                }

                const otherPages = commandList.find(
                    ".EpListBLine ul.pagination li.num"
                ).length;
                const nbPages = otherPages || 1;

                // If there are are several pages, parse all the pages to retrieve all the
                // bills
                if (nbPages > 1) {
                    let totalPagesParsed = 0;
                    const billsList = $(billsTableSelector);
                    const _fetchPageFromIndex = idx => {
                        const pageOptions = Object.create(billsOptions);
                        pageOptions.url += `?page=${idx}`;
                        logger.info(`Fetching page ${idx} of ${nbPages}…`);
                        fetchBillPageBillsList(pageOptions, rows => {
                            // We now reinsert the rows in the first page's list
                            if (rows) {
                                billsList.append(rows);
                            }

                            if (++totalPagesParsed === nbPages - 1) {
                                logger.info("All bills pages fetched");
                                return resolve($.html());
                            }
                        });
                    };

                    for (let pageIndex = 2; pageIndex <= nbPages; ++pageIndex) {
                        _fetchPageFromIndex(pageIndex);
                    }
                } else {
                    return resolve(body);
                }
            });
        });
    });
}

function parsePage(html) {
    const bills = [];

    const rows = extractBillsRows(html);
    for (const row of rows) {
        const cells = row.find("td");
        // First cell is a number (not the ref)
        const ref = cells
            .eq(1)
            .text()
            .trim();
        const date = cells
            .eq(2)
            .text()
            .trim();
        const price = cells
            .eq(3)
            .text()
            .trim()
            .replace(" €", "")
            .replace(",", ".");
        const status = cells
            .eq(4)
            .text()
            .trim()
            .toLowerCase();

        // Hacky to way to check without dealing with accents
        if (status.startsWith("termin") || status.startsWith("commande exp")) {
            const bill = {
                date: moment(date, "DD/MM/YYYY").toDate(),
                amount: parseFloat(price),
                fileurl: `${baseURL}pm/client/facture.nt.html?ref=${ref}`,
                filename: `${moment(date, "DD/MM/YYYY").format(
                    "YYYYMMDD"
                )}_Materiel.net.pdf`,
                vendor: "Materiel.net",
                requestOptions: {
                    jar: j
                }
            };

            bills.push(bill);
        }
    }

    logger.info(`${bills.length} bill(s) retrieved`);
    return bills;
}
