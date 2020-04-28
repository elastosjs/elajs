
# ela-js - Elastos Community JS SDK - [www.elajs.com](https://www.elajs.com)

See docs at: http://docs.elajs.com

Tutorials at: http://tutorials.elajs.com

## This is an ALPHA - Proof-of-Concept Version

Expect significant changes between this and the next BETA release.

### All Methods are Temporary

Right now a lot of methods simply mirror the smart contract, but in the later versions we plan to 
make it more similar to [https://github.com/hiddentao/squel](Squel) where you build query objects.

Then we would translate those query objects into a promise and issues successive calls to the smart
contract to apply that query. 

### Semantics

- we expect `bytes32` to be `Buffers`
- a hex value always has the `0x` prefix
- any crypto functions always return a hex value, we assume you don't need intermediates  
