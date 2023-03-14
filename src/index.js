process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://48d00cbdb62d46c0b2dcac870b9241fa@errors.cozycloud.cc/33'

const { BaseKonnector, requestFactory, log } = require('cozy-konnector-libs')
const jar = require('request').jar()
const cheerio = require('cheerio')

const requestHTML = requestFactory({
  // debug: true,
  cheerio: true,
  // json: true,
  jar
})

const requestJSON = requestFactory({
  // debug: true,
  // cheerio: true,
  json: true,
  jar
})

const VENDOR = 'materiel.net'

module.exports = new BaseKonnector(start)

async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) {
    log('debug', 'Found COZY_PARAMETERS')
  }
  const { identity, customer } = await authenticate.bind(this)(
    fields.login,
    fields.password
  )
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of bills')
  const ordersPeriods = await parseBills(identity, customer)
  log('info', 'Parsing list of bills')
  log('info', 'Fetching the list of documents')
  const bills = await getBills(ordersPeriods, identity, customer)
  log('info', 'Saving bills data to Cozy')
  await this.saveBills(bills, fields, {
    identifiers: ['Materiel.net'],
    fileIdAttributes: ['vendorRef'],
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    contentType: 'application/pdf'
  })
}

async function authenticate(username, password) {
  await requestHTML({
    url: 'https://www.materiel.net',
    headers: {
      'accept-encoding': 'gzip, deflate, br'
    }
  })
  await requestHTML({
    url: 'https://www.materiel.net/form/newsletter/subscribe',
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' }
  })
  await requestHTML({
    url: 'https://www.materiel.net/form/login',
    headers: { 'x-requested-with': 'XMLHttpRequest' }
  })
  const $ = await requestHTML({
    url: 'https://www.materiel.net/form/login',
    headers: { 'x-requested-with': 'XMLHttpRequest' }
  })
  const reqVerifToken = $('input[name="__RequestVerificationToken"]').attr(
    'value'
  )

  const loginReq = await requestJSON({
    url: 'https://www.materiel.net/form/submit_login',
    method: 'POST',
    formSelector: '#loginForm',
    form: {
      __RequestVerificationToken: `${reqVerifToken}`,
      Email: username,
      Password: password,
      LongAuthenticationDuration: false
    }
  })
    .catch(err => {
      log('err', err)
    })
    .then(resp => {
      return resp
    })

  const cookies = loginReq.setCookie
  let findIdentity
  let findCustomer
  for (let cookie of cookies) {
    if (cookie.includes('Identity')) {
      findIdentity = cookie
    } else if (cookie.includes('Customer')) {
      findCustomer = cookie
    }
  }
  const identity = findIdentity.split(';')[0]
  const customer = findCustomer.split(';')[0]

  return { identity, customer }
}

async function parseBills(identity, customer) {
  const getOrders = await requestJSON({
    url: 'https://secure.materiel.net/Orders/CompletedOrdersPeriodSelection',
    method: 'POST',
    jar: false,
    headers: {
      cookie: `${identity};${customer};`
    }
  })
  return getOrders
}

async function getBills(ordersPeriods, identity, customer) {
  let bills = []
  let orders = []
  let ordersByYear = []
  for (let i = 0; i < ordersPeriods.length; i++) {
    const ordersByPeriod = await requestHTML({
      url: 'https://secure.materiel.net/Orders/PartialCompletedOrdersHeader',
      jar: false,
      method: 'POST',
      headers: {
        cookie: `${identity};${customer};`
      },
      form: {
        Duration: ordersPeriods[i].Duration,
        Value: ordersPeriods[i].Value
      }
    })
    const splitOrders = Array.from(ordersByPeriod('div[class="historic"]'))
    for (const div of splitOrders) {
      const $div = ordersByPeriod(div).html()
      ordersByYear.push($div)
    }
  }

  for (let i = 0; i < ordersByYear.length; i++) {
    const $ = cheerio.load(ordersByYear[i])
    const getOrderHref = $('a[class="collapsed"]').attr('href')
    const orderHref = getOrderHref.split('#')[0]
    const getOrderDate = $('.historic-cell--date').text()
    // Here we split the Date to get the right date format
    const splitOrderDate = getOrderDate.split('/')
    const orderDay = splitOrderDate[0]
    const orderMonth = splitOrderDate[1]
    const orderYear = splitOrderDate[2]
    // Now date is formatted to YYYY-MM-DD
    const orderDate = `${orderYear}-${orderMonth}-${orderDay}`
    const getVendorRef = $('.historic-cell--ref')
    const vendorRef = getVendorRef.html().split(' ')[1]
    const getPrice = $('.historic-cell--price')
    const trimPrice = getPrice.html().replace(' ', '')
    const numbers = trimPrice.match(/\d+/g)
    const stringedAmount = `${numbers[0]}.${numbers[1]}`
    const amount = parseFloat(stringedAmount)

    const order = {
      filename: `${orderDate}_Materiel.net.pdf`,
      fileurl: orderHref,
      amount,
      vendorRef,
      orderDate
    }
    orders.push(order)
  }
  for (let i = 0; i < orders.length; i++) {
    const fullOrder = await requestHTML({
      url: `https://secure.materiel.net${orders[i].fileurl}`,
      method: 'POST',
      headers: {
        cookie: `${identity};${customer};`
      },
      'X-requested-with': 'XMLHttpRequest'
    })
    const $ = cheerio.load(fullOrder.html())

    const downloadHref = $('.o-btn--pdf').attr('href')
    orders[i].fileurl = `https://secure.materiel.net${downloadHref}`

    let bill = {
      ...orders[i],
      vendor: VENDOR,
      currency: 'EUR',
      date: new Date(),
      requestOptions: {
        method: 'GET',
        jar
      },
      fileAttributes: {
        contentAuthor: 'materiel.net',
        datetime: new Date(orders[i].orderDate),
        datetimeLabel: 'issueDate'
      }
    }
    bills.push(bill)
  }
  return bills
}
