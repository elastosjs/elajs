import { _clone } from './helpers'

class Select {
  constructor() {
    this._fields = []
    this._table = null
    this._conditions = []
  }

  clone() {
    let newInstance = new this.constructor()

    return Object.assign(newInstance, _clone(Object.assign({}, this)))
  }
}
