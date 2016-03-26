'use strict';
var Wallet = function(priv) {
	this.privKey = priv.length == 32 ? priv : Buffer(priv, 'hex')
}
Wallet.generate = function(icapDirect) {
	if (icapDirect) {
		while (true) {
			var privKey = ethUtil.crypto.randomBytes(32)
			if (ethUtil.privateToAddress(privKey)[0] === 0) {
				return new Wallet(privKey)
			}
		}
	} else {
		return new Wallet(ethUtil.crypto.randomBytes(32))
	}
}
Wallet.prototype.getPrivateKey = function() {
	return this.privKey
}
Wallet.prototype.getPrivateKeyString = function() {
	return this.getPrivateKey().toString('hex')
}
Wallet.prototype.getPublicKey = function() {
	return ethUtil.privateToPublic(this.privKey)
}
Wallet.prototype.getPublicKeyString = function() {
	return '0x' + this.getPublicKey().toString('hex')
}
Wallet.prototype.getAddress = function() {
	return ethUtil.privateToAddress(this.privKey)
}
Wallet.prototype.getAddressString = function() {
	return '0x' + this.getAddress().toString('hex')
}
Wallet.prototype.getChecksumAddressString = function() {
	return ethUtil.toChecksumAddress(this.getAddressString())
}
Wallet.fromPrivateKey = function(priv) {
	return new Wallet(priv)
}
Wallet.fromEthSale = function(input, password) {
	var json = (typeof input === 'object') ? input : JSON.parse(input)
	var encseed = new Buffer(json.encseed, 'hex')
	var derivedKey = ethUtil.crypto.pbkdf2Sync(Buffer(password), Buffer(password), 2000, 32, 'sha256').slice(0, 16)
	var decipher = ethUtil.crypto.createDecipheriv('aes-128-cbc', derivedKey, encseed.slice(0, 16))
	var seed = decipherBuffer(decipher, encseed.slice(16))
	var wallet = new Wallet(ethUtil.sha3(seed))
	if (wallet.getAddress().toString('hex') !== json.ethaddr) {
		throw new Error('Decoded key mismatch - possibly wrong passphrase')
	}
	return wallet
}
Wallet.prototype.toV3 = function(password, opts) {
	opts = opts || {}
	var salt = opts.salt || ethUtil.crypto.randomBytes(32)
	var iv = opts.iv || ethUtil.crypto.randomBytes(16)
	var derivedKey
	var kdf = opts.kdf || 'scrypt'
	var kdfparams = {
		dklen: opts.dklen || 32,
		salt: salt.toString('hex')
	}
	if (kdf === 'pbkdf2') {
		kdfparams.c = opts.c || 262144
		kdfparams.prf = 'hmac-sha256'
		derivedKey = ethUtil.crypto.pbkdf2Sync(new Buffer(password), salt, kdfparams.c, kdfparams.dklen, 'sha256')
	} else if (kdf === 'scrypt') {
		// FIXME: support progress reporting callback
		kdfparams.n = opts.n || 262144
		kdfparams.r = opts.r || 8
		kdfparams.p = opts.p || 1
		derivedKey = ethUtil.scrypt(new Buffer(password), salt, kdfparams.n, kdfparams.r, kdfparams.p, kdfparams.dklen)
	} else {
		throw new Error('Unsupported kdf')
	}
	var cipher = ethUtil.crypto.createCipheriv(opts.cipher || 'aes-128-ctr', derivedKey.slice(0, 16), iv)
	if (!cipher) {
		throw new Error('Unsupported cipher')
	}
	var ciphertext = Buffer.concat([cipher.update(this.privKey), cipher.final()])
	var mac = ethUtil.sha3(Buffer.concat([derivedKey.slice(16, 32), new Buffer(ciphertext, 'hex')]))
	return {
		version: 3,
		id: ethUtil.uuid.v4({
			random: opts.uuid || ethUtil.crypto.randomBytes(16)
		}),
		address: this.getAddress().toString('hex'),
		Crypto: {
			ciphertext: ciphertext.toString('hex'),
			cipherparams: {
				iv: iv.toString('hex')
			},
			cipher: opts.cipher || 'aes-128-ctr',
			kdf: kdf,
			kdfparams: kdfparams,
			mac: mac.toString('hex')
		}
	}
}
Wallet.prototype.toJSON = function(){
    return {
		address:this.getAddressString(),
        checksumAddress:this.getChecksumAddressString(),
        privKey:this.getPrivateKeyString(),
        pubKey:this.getPublicKeyString()
	}
}
Wallet.fromMyEtherWallet = function(input, password) {
	var json = (typeof input === 'object') ? input : JSON.parse(input)
	var privKey
	if (!json.locked) {
		if (json.private.length !== 64) {
			throw new Error('Invalid private key length')
		}
		privKey = new Buffer(json.private, 'hex')
	} else {
		if (typeof password !== 'string') {
			throw new Error('Password required')
		}
		if (password.length < 7) {
			throw new Error('Password must be at least 7 characters')
		}
		var cipher = json.encrypted ? json.private.slice(0, 128) : json.private
		cipher = decodeCryptojsSalt(cipher)
		var evp = evp_kdf(new Buffer(password), cipher.salt, {
			keysize: 32,
			ivsize: 16
		})
		var decipher = ethUtil.crypto.createDecipheriv('aes-256-cbc', evp.key, evp.iv)
		privKey = decipherBuffer(decipher, new Buffer(cipher.ciphertext))
		privKey = new Buffer((privKey.toString()), 'hex')
	}
	var wallet = new Wallet(privKey)
	if (wallet.getAddressString() !== json.address) {
		throw new Error('Invalid private key or address')
	}
	return wallet
}
Wallet.prototype.toV3String = function(password, opts) {
	return JSON.stringify(this.toV3(password, opts))
}

function decipherBuffer(decipher, data) {
	return Buffer.concat([decipher.update(data), decipher.final()])
}

function decodeCryptojsSalt(input) {
	var ciphertext = new Buffer(input, 'base64')
	if (ciphertext.slice(0, 8).toString() === 'Salted__') {
		return {
			salt: ciphertext.slice(8, 16),
			ciphertext: ciphertext.slice(16)
		}
	} else {
		return {
			ciphertext: ciphertext
		}
	}
}

function evp_kdf(data, salt, opts) {
	// A single EVP iteration, returns `D_i`, where block equlas to `D_(i-1)`

	function iter(block) {
		var hash = ethUtil.crypto.createHash(opts.digest || 'md5')
		hash.update(block)
		hash.update(data)
		hash.update(salt)
		block = hash.digest()
		for (var i = 1; i < (opts.count || 1); i++) {
			hash = ethUtil.crypto.createHash(opts.digest || 'md5')
			hash.update(block)
			block = hash.digest()
		}
		return block
	}
	var keysize = opts.keysize || 16
	var ivsize = opts.ivsize || 16
	var ret = []
	var i = 0
	while (Buffer.concat(ret).length < (keysize + ivsize)) {
		ret[i] = iter((i === 0) ? new Buffer(0) : ret[i - 1])
		i++
	}
	var tmp = Buffer.concat(ret)
	return {
		key: tmp.slice(0, keysize),
		iv: tmp.slice(keysize, keysize + ivsize)
	}
}
module.exports = Wallet;