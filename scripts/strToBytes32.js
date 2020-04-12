
const { strToBytes32 } = require('../dist/ela-js.cjs.js')

console.log('0x' + strToBytes32(process.argv[2]).toString('hex'))
