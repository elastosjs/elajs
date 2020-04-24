

if (!process.env.NODE_ENV){
  console.error('missing NODE_ENV')
  process.exit(0)
}

if (process.env.NODE_ENV !== 'local'){
  console.error('NODE_ENV must be "local" for tests')
  process.exit(0)
}

// we keep everything in ENV
require('dotenv').config({
  path: __dirname + '/env/local.env'
})
