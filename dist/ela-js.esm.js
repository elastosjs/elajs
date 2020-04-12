import _ from 'lodash';

function _defineProperty(obj, key, value) {
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }

  return obj;
}

function ownKeys(object, enumerableOnly) {
  var keys = Object.keys(object);

  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object);
    if (enumerableOnly) symbols = symbols.filter(function (sym) {
      return Object.getOwnPropertyDescriptor(object, sym).enumerable;
    });
    keys.push.apply(keys, symbols);
  }

  return keys;
}

function _objectSpread2(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i] != null ? arguments[i] : {};

    if (i % 2) {
      ownKeys(Object(source), true).forEach(function (key) {
        _defineProperty(target, key, source[key]);
      });
    } else if (Object.getOwnPropertyDescriptors) {
      Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
    } else {
      ownKeys(Object(source)).forEach(function (key) {
        Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
      });
    }
  }

  return target;
}

var bytes32ToStr = function bytes32ToStr(buf) {
  return _.trimStart(buf.toString(), "\0");
};

var bytes32ToUint = function bytes32ToUint(buf) {
  var buf4 = new Buffer.alloc(4);
  buf.copy(buf4, 0, 28);
  return parseInt(buf4.readUInt32BE().toString(10));
};

var bytesToTypes = {
  bytes32ToStr: bytes32ToStr,
  bytes32ToUint: bytes32ToUint
};

var strToBytes32 = function strToBytes32(input) {
  var targetBuf = new Buffer.alloc(32);
  var inputBuf = new Buffer.from(input);
  var inputByteLen = inputBuf.byteLength; // overflow isn't written

  inputBuf.copy(targetBuf, inputByteLen < 32 ? 32 - inputByteLen : 0);
  return targetBuf;
};

var uintToBytes32 = function uintToBytes32(input) {
  var inputBuf = new Buffer.alloc(4);
  inputBuf.writeUInt32BE(input);
  var targetBuf = new Buffer.alloc(32);
  inputBuf.copy(targetBuf, 28);
  return targetBuf;
};

var typesToBytes = {
  strToBytes32: strToBytes32,
  uintToBytes32: uintToBytes32
};

var _require = require('sha3'),
    Keccak = _require.Keccak;

var sha3 = new Keccak(256);

function namehashInner(input) {
  if (input === '') {
    return new Buffer.alloc(32);
  }

  var inputSplit = input.split('.');
  var label = inputSplit.shift();
  var remainder = inputSplit.join('.');
  var labelSha3 = sha3.update(label).digest();
  console.log(labelSha3.toString('hex'));
  sha3.reset();
  var iter = sha3.update(Buffer.concat([namehashInner(remainder), labelSha3])).digest();
  sha3.reset(); // TODO: figure out why this needs to be here

  return iter;
}

function namehash(input) {
  return '0x' + namehashInner(input).toString('hex');
}
 // 0000000000000000000000000000000000000000000000000000000000000000

var _require$1 = require('sha3'),
    Keccak$1 = _require$1.Keccak;

var sha3$1 = new Keccak$1(256);

function keccak256(input) {
  if (input.substring(0, 2) === '0x') {
    input = Buffer.from(input.substring(2), 'hex');
    console.log(input);
  }

  sha3$1.reset();
  var hash = sha3$1.update(input).digest();
  return '0x' + hash.toString('hex');
}

var exports = _objectSpread2({
  namehash: namehash,
  keccak256: keccak256
}, bytesToTypes, {}, typesToBytes);

export default exports;
