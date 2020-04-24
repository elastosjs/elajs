

// get whether object is a plain object
export function _isPlainObject(obj) {
  return (obj && obj.constructor.prototype === Object.prototype)
}


// get whether object is an array
export function _isArray(obj) {
  return (obj && obj.constructor.prototype === Array.prototype)
}



// clone given item
export function _clone(src) {
  if (!src) {
    return src
  }

  if (typeof src.clone === 'function') {
    return src.clone()
  } else if (_isPlainObject(src) || _isArray(src)) {
    let ret = new (src.constructor)

    Object.getOwnPropertyNames(src).forEach(function(key) {
      if (typeof src[key] !== 'function') {
        ret[key] = _clone(src[key])
      }
    })

    return ret
  } else {
    return JSON.parse(JSON.stringify(src))
  }
}
