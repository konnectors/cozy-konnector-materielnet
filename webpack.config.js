var path = require('path')
const CopyPlugin = require('copy-webpack-plugin')
const fs = require('fs')

const entry = require('./package.json').main

let iconName
try {
    iconName = JSON.parse(fs.readFileSync('manifest.konnector', 'utf8')).icon
    // we run optimize only on SVG
    if (!iconName.match(/\.svg$/)) iconName = null
} catch (e) {
    console.error(`Unable to read the icon path from manifest: ${e}`)
}

module.exports = {
    entry,
    target: 'node',
    mode: 'none',
    output: {
        path: path.join(__dirname, 'build'),
        filename: 'index.js'
    },
    plugins: [
        new CopyPlugin([
            { from: 'manifest.konnector' },
            { from: 'package.json' },
            { from: 'README.md' },
            { from: 'assets' },
            { from: '.travis.yml' },
            { from: 'LICENSE' }
        ])
    ]
}
