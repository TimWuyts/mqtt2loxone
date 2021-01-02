#!/usr/bin/env node

/**
 * SETUP
 */

const log = require('yalm')
const mqtt = require('mqtt')
const dgram = require('dgram')
const request = require('request')
const encodeurl = require('encodeurl')

const pkg = require('./package.json')
const cfg = require(process.argv[2] || './config.json')

log.setLevel(cfg.log)
log.info(pkg.name + ' ' + pkg.version + ' starting')

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
    mqttClient.publish(cfg.mqtt.name + '/connected', '2', { retain: true })

    log.info('mqtt: connected ' + cfg.mqtt.url)

    mqttClient.subscribe(cfg.mqtt.name + '/set/#')

    for (const subscriptionKey in cfg.loxone.subscriptions) {
        mqttClient.subscribe(cfg.loxone.subscriptions[subscriptionKey])
    }
})

mqttClient.on('close', () => {
    log.info('mqtt: disconnected ' + cfg.mqtt.url)
})

mqttClient.on('error', err => {
    log.error('mqtt: error ' + err.message)
})

mqttClient.on('message', (topic, payload, msg) => {
    payload = JSON.parse(payload.toString())

    log.info('mqtt: message ' + topic + ' ' + payload.toString())

    if ('val' in payload) {
        if (typeof (payload.val) !== 'string') {
            let message = topic

            if (payload.val != null) message += '=' + payload.val

            udpMessage(message)
        } else {
            apiMessage(('name' in payload) ? payload.name : 'unknown', payload.val)
        }
    } else {
        const entries = Object.entries(payload)

        for (const [key, value] of entries) {
            if (typeof (value) !== 'string') {
                if (value != null) udpMessage(key + '=' + value)
            } else {
                apiMessage(key, value)
            }
        }
    }
})

/**
 * UDP SERVER
 */

const udpServer = dgram.createSocket('udp4')
udpServer.bind(cfg.loxone.port)

udpServer.on('listening', () => {
    log.info('udp server: listen on udp://' + udpServer.address().address + ':' + udpServer.address().port)
})

udpServer.on('close', () => {
    log.info('udp server: closed')
})

udpServer.on('message', (message, remote) => {
    message = message.toString().trim()
    let messageParts = message.split(';')

    log.info('udp server: message from udp://' + remote.address + ':' + remote.port + ' => ' + message)

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

    log.info('mqtt: publish ' + topic + ' ' + payload)
    mqttClient.publish(topic, payload, { qos: qos, retain: retain })
})

udpServer.on('error', (err) => {
    log.error(err)
})

/**
 * UDP CLIENT
 */

function udpMessage (message) {
    const udpClient = dgram.createSocket('udp4')

    log.info('udp client: send datagram ' + message)

    udpClient.send(message, cfg.loxone.port, cfg.loxone.host, (error) => {
        if (error) log.error('udp client error: ' + error)

        udpClient.close()
    })
}

/**
 * LOXONE API
 */

function apiMessage (name, message) {
    const base = cfg.loxone.host + '/dev/sps/io/' + name + '/' + message
    const url = encodeurl('http://' + cfg.loxone.username + ':' + cfg.loxone.password + '@' + base)

    log.info('http client: invoke request http://' + base)

    request(url, (error, response, body) => {
        if (error) log.error('http client error: ' + error)
    })
}
