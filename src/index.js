const cheerio = require("cheerio");
const moment = require("moment");

const {
    CookieKonnector,
    log,
    errors
} = require("cozy-konnector-libs");

const logger = {
    info: msg => log("info", msg),
    error: msg => log("error", msg),
    debug: msg => log("debug", msg)
};

const baseURL = "https://secure.materiel.net";

class MaterielnetKonnector extends CookieKonnector {
    async testSession() {
        const testSessionOptions = {
            url : 'https://secure.materiel.net/Orders/CompletedOrdersPeriodSelection',
            followRedirect: false,
            followAllRedirects: false
        };
        try {
            await this.request(testSessionOptions);
        }
        catch (err) {
            if (err.statusCode === 302) {
                return false;
            }
            else {
                throw new Error(errors.UNKOWN_ERROR);
            }
        }
        // We encounter a 200 on Orders page
        logger.info('Login cookies seems to be valid')
        return true;
    }

    async fetch(fields) {
        if (!(await this.testSession())) {
            logger.info('Found no correct session, logging in...');
            const loginToken = await this.fetchLoginToken();
            await this.login(loginToken, fields);
        }
        const billsPeriods = await this.fetchBillsPeriods();
        const bills = await this.fetchBills(billsPeriods);

        logger.info(`${bills.length} bill(s) retrieved`);
        await this.saveBills(bills, fields.folderPath, {
            identifiers: ["materiel.net"]
        });
    }

    async fetchLoginToken() {
        const loginPageTokenOptions = {
            method: "GET",
            ecdhCurve: "auto",
            url: `${baseURL}/Login/Login`
        };

        return new Promise((resolve, reject) => {
            logger.info("Retrieving login token");
            this.request(loginPageTokenOptions, (err, res) => {
                let token = "";
                if (!err) {
                    let $ = cheerio.load(res.body);
                    token = $("#login form input[name='__RequestVerificationToken']").val();
                    if (!token)
                        err = new Error("No login token found");
                }

                if (err) {
                    logger.debug(err.message);
                    logger.error("Could not retrieve login token");
                    return reject(new Error(errors.LOGIN_FAILED));
                }
                return resolve(token);
            });
        });
    }

    // Login layer
    async login(loginToken, requiredFields) {
        const signInOptions = {
            method: "POST",
            ecdhCurve: "auto",
            url: `https://www.materiel.net/form/submit_login`,
            form: {
                Email: requiredFields.login,
                Password: requiredFields.password,
                __RequestVerificationToken: loginToken
            }
        };

        return new Promise((resolve, reject) => {
            logger.info("Signing in");
            this.request(signInOptions, (err, res, body) => {
                let errType = "";
                if (err) {
                    errType = errors.VENDOR_DOWN;
                }
                else {
                    try {
                        body = JSON.parse(body);
                        if (!body || !body.authenticationSuccess || !body.user) {
                            if (typeof(body.loginForm) === "string" && body.loginForm.includes('window.renderCaptcha()')) {
                                errType = 'USER_ACTION_NEEDED.CAPTCHA';
                            }
                            else {
                                errType = errors.LOGIN_FAILED;
                            }
                        }
                    }
                    catch (e) {
                        console.log(e)
                        logger.error("Cannot parse response");
                        errType = errors.LOGIN_FAILED;
                    }
                }

                if (errType) {
                    logger.error("Signin failed");
                    return reject(new Error(errType));
                }

                let cookie = `ID=${body.user.Id}&KEY=${body.user.AuthenticationCode}`;
                this._jar.setCookie(`Customer=${cookie}`, "https://secure.materiel.net");

                logger.info("Logged in successfully");
                return resolve();
            });
        });
    }

    async fetchBillsPeriods() {
        const billsOptions = {
            method: "GET",
            ecdhCurve: "auto",
            url: `${baseURL}/Orders/CompletedOrdersPeriodSelection`
        };

        return new Promise((resolve, reject) => {
            logger.info("Fetching bills periods");
            this.request(billsOptions, (err, res, body) => {
                if (!err) {
                    try {
                        if (typeof(body) === "string") {
                            body = JSON.parse(body);
                        }
                    }
                    catch (e) {
                        err = new Error("Could not parse bills periods list");
                    }
                }

                if (err) {
                    logger.debug(err.message);
                    logger.error("An error occured while fetching bills periods list");
                    return reject(new Error(errors.UNKNOWN_ERROR));
                }

                return resolve(body);
            });
        });
    }

    async fetchBillsFromPeriod(period) {
        const billsListOptions = {
            method: "GET",
            ecdhCurve: "auto",
            url: `${baseURL}/Orders/PartialCompletedOrdersHeader`,
            form: period
        };

        return new Promise((resolve, reject) => {
            logger.info(`Fetching bills list for period ${period.Value}`);
            this.request(billsListOptions, (err, res, body) => {
                if (err) {
                    logger.error(`An error occured while fetching bills list for ${period.Value}`);
                    return reject(new Error(errors.UNKNOWN_ERROR));
                }

                let bills = [];
                let $ = cheerio.load(body);

                $(".historic").each((idx, b) => {
                    b = $(b);
                    let billRef = b.find(".historic-cell--ref").text().replace("Nº ", "").trim();
                    let billDate = moment(b.find(".historic-cell--date").text(), "DD/MM/YYYY");
                    let billPrice = parseFloat(
                        b.find(".historic-cell--price").text()
                            .replace(" TTC", "")
                            .replace("€", ".")
                            .trim()
                    );
                    let billUrl = b.find(".historic-cell--details a").attr("href")
                        .replace("PartialCompletedOrderContent", "DownloadOrderInvoice");

                    bills.push({
                        ref: billRef,
                        date: billDate.toDate(),
                        amount: billPrice,
                        fileurl: `${baseURL}${billUrl}`,
                        filename: `${billDate.format("YYYYMMDD")}_Materiel.net.pdf`,
                        vendor: "Materiel.net"
                    });
                });

                resolve(bills);
            });
        });
    }

    async fetchBills(billsPeriods) {
        let promises = [];

        for (let period of billsPeriods) {
            promises.push(fetchBillsFromPeriod(period));
        }

        return new Promise((resolve, reject) => {
            Promise.all(promises).then(bills => {
                // Flatten the bills
                bills = bills.reduce((acc, val) => acc.concat(val), []);
                resolve(bills);
            })
                .catch(err => {
                    reject(err);
                });
        });
    }

}

const konnector = new MaterielnetKonnector({
    //debug: true,
})

konnector.run()
