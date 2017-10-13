'use strict'

const request = require('request');
const cheerio = require('cheerio');
const moment = require('moment');

const {
    log,
    baseKonnector,
    filterExisting,
    saveDataAndFile,
    models,
    linkBankOperation
} = require('cozy-konnector-libs');

const Bill = models.bill;

const logger = {
    info: msg => log('info', msg),
    error: msg => log('error', msg)
};

const baseURL = 'https://www.materiel.net/';

const billsTableSelector = '#ListCmd table';

const fileOptions = {
    vendor: 'Materiel.net',
    dateFormat: 'YYYYMMDD'
};

/**
 * @param {string} html
 * @return cheerio[]
 */
function extractBillsRows(html) {
    const $ = cheerio.load(html);
    const container = $(billsTableSelector);
    return container.find('tr[data-order]').toArray().map(r => $(r));
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
function login(requiredFields, billInfos, data, next) {
    const signInOptions = {
        method: 'POST',
        jar: true,
        url: `${baseURL}pm/client/logincheck.nt.html`,
        form: {
            identifier: requiredFields.login,
            credentials: requiredFields.password,
            back: ''
        }
    };

    const billsOptions = {
        method: 'GET',
        jar: true,
        url: `${baseURL}pm/client/commande.html`
    };

    logger.info('Signing in')
    request(signInOptions, (err, res) => {
        if (err) {
            logger.error('Signin failed');
            return next('LOGIN_FAILED');
        }

        if (res.headers.location.indexOf('captcha') !== -1) {
            logger.error('Hit captcha webpage');
            return next('UNKNOWN_ERROR');
        }

        // Download bill information page.
        logger.info('Fetching bills list')
        request(billsOptions, (err, res, body) => {
            if (err) {
                logger.error('An error occured while fetching bills list');
                return next('UNKNOWN_ERROR');
            }

            // Check if there are several pages
            const $ = cheerio.load(body);
            const commandList = $('#ListCmd');

            if (!commandList.length) {
                logger.error('Could not parse page (did not find expected id)');
                return next('UNKNOWN_ERROR');
            }

            const otherPages = commandList.find('.EpListBLine ul.pagination li.num').length;
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

                        if (++totalPagesParsed === (nbPages - 1)) {
                            logger.info('All bills pages fetched');
                            data.html = $.html();
                            next();
                        }
                    });
                }

                for (let pageIndex = 2; pageIndex <= nbPages; ++pageIndex) {
                    _fetchPageFromIndex(pageIndex);
                }
            } else {
                data.html = body;
                next();
            }
        });
    });
}

function parsePage(requiredFields, bills, data, next) {
    bills.fetched = [];

    const rows = extractBillsRows(data.html);
    for (const row of rows) {
        const cells = row.find('td');
        // First cell is a number (not the ref)
        const ref = cells.eq(1).text().trim();
        const date = cells.eq(2).text().trim();
        const price = cells.eq(3).text().trim()
                               .replace(' €', '')
                               .replace(',', '.');
        const status = cells.eq(4).text()
                                .trim()
                                .toLowerCase();

        // Hacky to way to check without dealing with accents
        if (status.startsWith('termin') || status.startsWith('commande exp')) {
            const bill = {
                date: moment(date, 'DD/MM/YYYY'),
                amount: parseFloat(price),
                pdfurl: `${baseURL}pm/client/facture.nt.html?ref=${ref}`
            };

            bills.fetched.push(bill);
        }
    }

    logger.info(`${bills.fetched.length} bill(s) retrieved`);
    next();
}

function customFilterExisting(requiredFields, entries, data, next) {
    filterExisting(logger, Bill)(requiredFields, entries, data, next);
}

function customSaveDataAndFile(requiredFields, entries, data, next) {
    saveDataAndFile(logger, Bill, fileOptions, ['bill'])(
        requiredFields, entries, data, next);
}

module.exports = baseKonnector.createNew({
    name: 'Materiel.net',
    description: 'konnector description materiel_net',
    vendorLink: baseURL,

    category: 'others',
    color: {
        hex: '#D2312D',
        css: '#D2312D'
    },

    fields: {
        login: {
            type: 'text'
        },
        password: {
            type: 'password'
        },
        folderPath: {
            type: 'folder',
            advanced: true
        }
    },

    dataType: ['bill'],

    models: [Bill],

    fetchOperations: [
        login,
        parsePage,
        customFilterExisting,
        customSaveDataAndFile,
        linkBankOperation({
            log: logger,
            minDateDelta: 1,
            maxDateDelta: 1,
            model: Bill,
            amountDelta: 0.1,
            identifier: ['materiel.net']
        })
    ]
});
