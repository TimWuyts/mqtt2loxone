#!/usr/bin/env node

/**
 * SETUP
 */

const log = require('yalm')
const mqtt = require('mqtt')
const dgram = require('dgram')
const fetch = require('node-fetch')
const encodeurl = require('encodeurl')

const pkg = require('./package.json')
const cfg = require(process.argv[2] || './config.json')

log.setLevel(cfg.log)
log.info(`${pkg.name} ${pkg.version} starting`)

/**
 * SETUP MQTT
 */

const mqttClient = mqtt.connect(
    cfg.mqtt.url, {
        will: {
            topic: cfg.mqtt.name + '/connected',
            payload: '0',
            retain: true
        },
        rejectUnauthorized: cfg.mqtt.secure
    }
)

mqttClient.on('connect', () => {
    mqttClient.publish(`${cfg.mqtt.name}/connected`, '2', { retain: true })

    log.info(`mqtt: connected ${cfg.mqtt.url}`)

    mqttClient.subscribe(`${cfg.mqtt.name}/set/#`)

    cfg.loxone.subscriptions.forEach((subscription) => {
        mqttClient.subscribe(subscription.topic)
    })
})

mqttClient.on('close', () => {
    log.info(`mqtt: disconnected ${cfg.mqtt.url}`)
})

mqttClient.on('error', err => {
    log.error(`mqtt: error ${err.message}`)
})

mqttClient.on('message', (topic, payload, msg) => {
    const payloadString = payload.toString()

    payload = JSON.parse(payloadString)
    log.info(`mqtt: message ${topic} ${payloadString}`)

    // payload equals to "param=value"
    if (typeof (payload) === 'string') {
        udpMessage(topic, payload)
    }

    if ('val' in payload) {
        // payload equals to "{ name: param, val: value }"
        if (typeof (payload.val) === 'string') {
            apiMessage(topic, payload.name, payload.val)
        } else {
            udpMessage(topic, `${payload.name}=${payload.val}`)
        }
    } else {
        // payload equals to "{ param1: val1, param2: val2, ... }"
        const subscription = cfg.loxone.subscriptions.find(item => item.topic.includes(topic))

        if (subscription && subscription.fields) {
            // follow pre-defined field definitions
            for (const field of subscription.fields) {
                const key = field.name
                const value = payload[key]

                if (field.type === 'string') {
                    apiMessage(topic, key, String(value))
                } else {
                    udpMessage(topic, `${key}=${value}`)
                }
            }
        } else {
            // loop trough all available fields
            const entries = Object.entries(payload)

            for (const [key, value] of entries) {
                if (typeof (value) === 'string') {
                    apiMessage(topic, key, value)
                } else {
                    if (value != null) udpMessage(topic, `${key}=${value}`)
                }
            }
        }
    }
})

/**
 * UDP SERVER
 */

const udpServer = dgram.createSocket('udp4')
udpServer.bind(cfg.udp.port)

udpServer.on('listening', () => {
    log.info(`udp server: listen on udp://${udpServer.address().address}:${udpServer.address().port}`)
})

udpServer.on('close', () => {
    log.info(`udp server: closed`)
})

udpServer.on('message', (message, remote) => {
    message = message.toString().trim()
    let messageParts = message.split(';')

    log.info(`udp server: message from udp://${remote.address}:${remote.port} => ${message}`)

    // check if the message was send by the logger or by the UDP virtual output and concatenate the array if it's the logger
    const regexLogger = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2};.*$/g
    if (message.match(regexLogger) != null) {
        messageParts = messageParts.splice(2)
    }

    // define topic. This must be in the udp message
    const topic = messageParts[0]

    // define value. Can be null or empty
    let value = ''

    if (messageParts.length > 1) {
        value = messageParts[1]
    }

    // define the mqtt qos. Default is 0
    let qos = 0

    if (messageParts.length > 2) {
        qos = parseInt(messageParts[2])
    }

    // define the mqtt retain. Default is false
    let retain = false

    if (messageParts.length > 3) {
        retain = messageParts[3] === 'true'
    }

    // define the optional name payload string. Default is not defined
    let name = null

    if (messageParts.length > 4) {
        name = messageParts[4]
    }

    // add the default prefix if the custom prefix is not specified
    let mode = 'json_raw'

    if (messageParts.length > 5) {
        mode = messageParts[5]
    }

    // parse the value, to publish the correct format
    let parsedValue

    if (value === '') {
        parsedValue = ''
    } else if (value === 'true') {
        parsedValue = 1
    } else if (value === 'false') {
        parsedValue = 0
    } else if (!isNaN(value)) {
        parsedValue = Number(value)
    } else {
        parsedValue = value
    }

    // prepare the payload object with timestamp, value and optionally the name
    let payload = parsedValue

    switch (mode) {
    case 'json':
        payload = {
            ts: Date.now(),
            val: parsedValue
        }

        if (name !== null) {
            payload.name = name
        }

        payload = JSON.stringify(payload)
        break
    case 'json_raw':
        // nothing specific at the moment
        break
    }

    log.info(`mqtt: publish ${topic} ${payload}`)
    mqttClient.publish(topic, payload, { qos: qos, retain: retain })
})

udpServer.on('error', (err) => {
    log.error(err)
})

/**
 * UDP CLIENT
 */

function udpMessage (topic, message) {
    const udpClient = dgram.createSocket('udp4')
    const parts = message.split('=')

    let param = parts[0]
    let value = parts[1]

    // set field identifier, if needed
    const subscription = cfg.loxone.subscriptions.find(item => item.topic.includes(topic))

    if (subscription && subscription.identifier !== '') {
        param = `${subscription.identifier}_${param}`
    }

    // cast boolean(ish) values to number values
    if (value === 'true' || value === 'yes') value = 1
    if (value === 'false' || value === 'no' || value === 'null' || value === null) value = 0

    // perform request
    message = (param + '=' + value).toLowerCase()
    log.info(`udp client: send datagram ${message}`)

    udpClient.send(message, cfg.udp.port, cfg.udp.host, (error) => {
        if (error) log.error(`udp client error: ${error}`)

        udpClient.close()
    })
}

/**
 * LOXONE API
 */

function apiMessage (topic, name, message) {
    // set field identifier, if needed
    const subscription = cfg.loxone.subscriptions.find(item => item.topic.includes(topic))

    if (subscription && subscription.identifier !== '') {
        name = `${subscription.identifier} - ${name}`
    }

    // perform request
    const url = encodeurl(`http://${cfg.loxone.username}:${cfg.loxone.password}@${cfg.loxone.host}:${cfg.loxone.port}/dev/sps/io/${name}/${message}`)

    log.info(`http client: invoke request ${url}`)
    fetch(url).catch(error => log.error(`http client error: ${error}`))
}
