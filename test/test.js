const assert = require('assert');

const {
  strToBytes32,
  bytes32ToStr,

  uintToBytes32,
  bytes32ToUint
} = require('../dist/elajs.umd')

const loremBytes32 = strToBytes32('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.')
console.log(bytes32ToStr(loremBytes32))

const numAsBytes32 = uintToBytes32(25)
console.log(numAsBytes32)
console.log(bytes32ToUint(numAsBytes32))
