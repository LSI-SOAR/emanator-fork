const child_process = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const request = require('request');
const progress = require('request-progress');
const glob = require('glob');
const colors = require('colors');
const AdmZip = require('adm-zip');
const _ = require('underscore');

class Utils {

	constructor(E) {
		this.E = E;
		if(process.platform == 'win32')
			this.PLATFORM_PATH_SEPARATOR = ';';
		else
			this.PLATFORM_PATH_SEPARATOR = ':';
	}

	log(...args) {
		return this.E.log(...args);
	}

	getDirFiles(dir, testRegExp){
		var result = [];
		var files = fs.readdirSync(dir);
		_.each(files, function(file) {
			var filePath = path.join(dir, file);
			var stat = fs.statSync(filePath);

			if(!stat.isDirectory()){
				if(!testRegExp || testRegExp.test(filePath)){
					result[result.length] = {filePath:filePath, name:file, parentDirName:dir.split(path.sep).pop(), stat:stat};
				}
				return
			}

			result = result.concat(getDirFiles(filePath, testRegExp));
		})

		return result;
	}

	download(url, file, callback) {
		if(callback)
			return this.download_(url, file, callback);

		return new Promise((resolve, reject) => {
			this.download_(url, file, (error) => {
				if(error)
					return reject(error);
				resolve();
			})
		})
	}

	download_(url, file, callback) {

		// const { DEPS } = this.E;
		let target = file; //path.join(DEPS,file);

		if(this.E.flags.force && fs.existsSync(target))
			fs.unlinkSync(target);

		if(fs.existsSync(target)) {
			this.log(`File found at ${target.bold}`);
			this.log(`Skipping download...`);
			return callback();
		}

		const hasTerm = !!process.stdout.columns;

		let  MAX = Math.max((process.stdout.columns || 0) - 55, 5), MIN = 0, value = 0;
		console.log("Fetching: "+url);
		console.log("");

		progress(request({
			url,
			headers: {
			'User-Agent': 'Emanator'
			}			
		}), {
			throttle : 250,
			delay : 1000
		})
		.on('progress', function (state) {
			if(state.percent > 0.99)
				state.percent = 1;

			if(!state.percent)
				state.percent = 0;

			let value = Math.ceil(state.percent * MAX);
			//      console.log("value", value, state, state.percent)
			if(hasTerm) {
				console.log('\x1B[1A\x1B[K|' +
					(new Array(value + 1)).join('█') + '' +
					(new Array(MAX - value + 1)).join('-') + '|  ' + (state.percent*100).toFixed(1) + '%  '
					+ state.size.transferred.toFileSize().split(' ').shift()+'/'
					+ state.size.total.toFileSize()+'  '
					+ (state.speed || 0).toFileSize()+'/s'
				);
			} else {
				console.log((state.percent*100).toFixed(1) + '%  '
					+ state.size.transferred.toFileSize().split(' ').shift()+'/'
					+ state.size.total.toFileSize()+'  '
					+ (state.speed || 0).toFileSize()+'/s'
				);
			}
		})
		.on('error', function (err) {
			console.log("error");
			err && console.log(err.toString());
			callback(err);
		})
		.pipe(fs.createWriteStream(target))
		.on('finish', function(err) {
			err && console.log(err.toString());
			callback();
		});
	}

	// TODO - 2019.11.27
	// a really nasty hack to battle some type of a TTY reset in Node
	// that occurs on Windows after certain applications, such as Git
	// stdout seems to loose it's ANSI-related TTY/terminal properties
	// resulting in loss of color and ANSI escape codes not being
	// recognized.  Running another child with 'inherit' seems to reset
	// the condition.
	resetTTY() {
		if(process.platform == 'win32')
			child_process.execFileSync('cmd.exe',['/Q','/C','echo.'], {stdio:'inherit'});		
	}

	spawn(...args) {
		return new Promise((resolve, reject) => {
			if(this.E.flags.verbose && _.isArray(args[1]))
				console.log("running:".bold,...args);

			let options = args[args.length-1] || { };
			let proc = child_process.spawn(...args);
			let done = false;

			if(options.stdout && typeof options.stdout == 'function')
				proc.stdout.on('data', options.stdout);

			proc.on('close', (code) => {
				if(!done) {
					resolve(code);
					done = true;
				}

				if(options.resetTTY && process.platform == 'win32') {
					process.nextTick(()=>{
						this.resetTTY();
					});
				}
			})

			proc.on('error', (err) => {
				if(!done) {
					done = true;
					reject(err);
				}
			})
		})
	}

	exec(file, args, options = { }) {
		return new Promise((resolve, reject) => {
			let text = '';
			options.stdout = (data) => { text += data.toString('utf8'); }
			this.spawn(file, args, options).then((code)=>{
				resolve(text);
			}).catch(reject);
		});

	}

	extract(...args) {
		return this.unzip(...args);
	}

	unzip(file, folder, options) {
		return new Promise((resolve,reject) => {
			this.unzip_(file, folder, options, (err) => {
				return err ? reject(err) : resolve();
			})
		})
	}

	async unzip_(file, folder, options, callback) {
		//const { DEPS } = this.E;

		if(this.E.flags.fast) {
			console.log(`FAST MODE: Skipping unzip for ${file}...`);
			return callback();
		}
		this.log(`Unzipping ${file.bold}...`)
		try {
			if(process.platform == 'win32' && file.match(/\.zip$/ig)) {
				let archive = new AdmZip(file);
				//let archive = new AdmZip(path.join(folder,file));
				archive.extractAllTo(folder, true);
				this.log(`Unzipping ${file.bold} success`)
				
				return callback();
			}
			else
			if(file.match(/\.zip$/ig)){
				let cwd = folder;
				fse.ensureDirSync(folder);
				console.log('unzip',file,folder);
				try {
					let flags = '-q';
					if(options?.overwrite)
						flags += 'o';
					await this.spawn('unzip',[flags,file],{ cwd, stdio:'inherit' });
				} catch(ex) {
					return callback(ex.toString());
				}
				return callback();
			}
			else
			if(file.match(/(\.zip|(\.tar(\.gz|\.xz)))?$/ig)) {
				let cwd = path.dirname(file);
				if(file.match(/\.zip$/)){
					cwd = folder;
					fse.ensureDirSync(folder);
				}
				console.log('tar','-xf',file,folder);
				try {
					await this.spawn('tar',['-xf',file],{ cwd, stdio:'inherit' });
				} catch(ex) {
					return callback(ex.toString());
				}
				return callback();
			}
			return callback(`no matching extension for ${file}`);
		} catch(ex) {
			console.log(("\nError: "+ex).red.bold);
			ex.stack && console.log(ex.stack);
			console.log((`\nIt looks like ${file} is corrupt...\nPlease use "--force" to re-download...\n`).red.bold);
			process.exit(1);
		}
	}

	zipFolder(folder,archive, level = 6) {
		return this.spawn('zip',[`-${level}`,'-qdgds','10m','-r', `${archive}`, './'], {
			cwd : folder,
			stdio : 'pipe',
			stdout : (data) => { process.stdout.write(data.toString().replace(/\r|\n/g,'')); }
		});
	}
	
	zip(what,archive, options) {
		const level = options?.level || 6;
		const cwd = options?.cwd || process.cwd();
		console.log('zip',`-${level}`,'-qdgds','10m','-r', archive, what);
		return this.spawn('zip',[`-${level}`,'-qdgds','10m','-r', archive, what], {
			cwd,
			stdio : 'pipe',
			stdout : (data) => { process.stdout.write(data.toString().replace(/\r|\n/g,'')); }
		});
	}	

	getConfig(name, defaults = null) {
	    function merge(dst, src) {
	        _.each(src, (v, k) => {
	            if(_.isArray(v)) { dst[k] = [ ]; merge(dst[k], v); }
	            else if(_.isObject(v)) { if(!dst[k] || _.isString(dst[k]) || !_.isObject(dst[k])) dst[k] = { };  merge(dst[k], v); }
	            else { if(_.isArray(src)) dst.push(v); else dst[k] = v; }
	        })
	    }

	    let filename = name+'.conf';
	    let host_filename = name+'.'+os.hostname()+'.conf';
	    let local_filename = name+'.local.conf';

	    let data = [ ];

	    fs.existsSync(filename) && data.push(fs.readFileSync(filename) || null);
	    fs.existsSync(host_filename) && data.push(fs.readFileSync(host_filename) || null);
	    fs.existsSync(local_filename) && data.push(fs.readFileSync(local_filename) || null);

	    if(!data[0] && !data[1]) {
	        console.error("Unable to read config file: ".bold+(filename+'').red.bold);
	        return defaults;
	    }

	    let o = defaults || { }
	    _.each(data, (conf) => {
	        if(!conf || !conf.toString('utf-8').length)
	            return;
	        let layer = eval('('+conf.toString('utf-8')+')');
	        merge(o, layer);
	    })

	    return o;
	}

	asyncMap(_list, fn, callback){
	    if(!_list || !_.isArray(_list))
	        return callback(new Error("asyncMap() supplied argument is not array"));
	    var list = _list.slice();
	    var result = [ ];
	    
	    var digest = ()=>{
	        var item = list.shift();
	        if(!item)
	            return callback(null, result);
	        fn(item, (err, data)=>{
	            if(err)
	                return callback(err);
	            data && result.push(data);
	            dpc(digest);
	        })
	    }

	    digest();
	}

	fileHash(filename, algorithm = 'sha1') {
		return new Promise((resolve, reject) => {
			// Algorithm depends on availability of OpenSSL on platform
			// Another algorithms: 'sha1', 'md5', 'sha256', 'sha512' ...
			let shasum = crypto.createHash(algorithm);
			try {
				let s = fs.ReadStream(filename)
				s.on('data', (data) => {
					shasum.update(data)
				})
				s.on('end', () => {
					resolve(shasum.digest('hex'));
				})
			} catch (error) {
				return reject(error);
			}
		});
	}

	copy(...args) {
		return fse.copy(...args);
	}

	move(...args) {
		return fse.move(...args);
	}

	remove(...args) {
		return fse.remove(...args);
	}

	mkdirp(...args) {
		return fse.mkdirp(...args);
	}

	emptyDir(...args) {
		return fse.emptyDir(...args);
	}

	ensureDir(...args) {
		return fse.ensureDir(...args);
	}

	match(text, regexp) {
	    return ((text && text.match(regexp) || {}).groups || {});
	}

	args(args) {
	    args = args || process.argv.slice(2);

	    let o = { }
	    args.map((arg) => {
	        const { prop, value } = this.match(arg,/^--(?<prop>[\w-]+)(=(?<value>.+))?$/);
	        if(value === undefined)
	            o[prop] = true;
	        else
	            o[prop] = value;
	    })
	    return o;
	}

	match(text, regexp) {
	    return ((text && text.match(regexp) || {}).groups || {});
	}

	whereis(binary, binaryInResults = false) {
		let list = process.env.PATH.split(this.PLATFORM_PATH_SEPARATOR)
			.filter(p => fs.existsSync(path.join(p,binary)));

		if(binaryInResults) {
			list = list.map(p => path.join(p,binary));
		}

		return list;
	}

	addToPath(p_) {
        let p = process.env.PATH.split(this.PLATFORM_PATH_SEPARATOR);
        p.unshift(p_);
        process.env.PATH = [...new Set(p)].join(this.PLATFORM_PATH_SEPARATOR);
    }

	glob(pattern, options) {
		return new Promise((resolve, reject) => {
			glob(pattern, options, (err, files) => {
				err && reject(err) || resolve(files);
			});
		})
	}



	async iterateFolder(root, enumerator, iterator) {
		// if(!enumerator)
		// 	return Promise.reject(`E::utils::iterateFolder() - enumerator required`);
		let files;

		if(!enumerator)
			files = this.matchFiles(root);
		else
			switch(typeof enumerator) {
				case 'string': {
					return this.glob(enumerator, { cwd : root });
				} break;
				case 'function': {
					let p = enumerator();
					files = typeof p?.then == 'function' ? await p : p;
				} break;
				case 'object': {
					if(typeof enumerator.then == 'function')
						files = await enumerator;
					else
					if(enumerator instanceof RegExp || typeof enumerator.test=='function')
						files = this.matchFiles(root, enumerator);
				} break;
			}

		if(!Array.isArray(files)) {
			console.log('error - invalid files value produced by enumerator:', files);
			return Promise.reject(`E::utils::iterateFolder() - enumerator produced 'files' value that is not an array`);
		}
		//const files = await this.glob(pattern, { cwd : root });
		const ctx = { folders : new Set() };
		const rootLen = root.length;
		//console.log("rp-", root, enumerator, files);
		while(files.length) {
			let file = files.shift();
			let dirname = path.dirname(file);
			let basename = path.basename(file);
			await iterator(file, file.substring(rootLen), ctx);
		}
	}

	async replicateFile(source, destination, ctx) {
		return new Promise(async (resolve, reject) => {
			let folder = path.dirname(destination);
			if(!ctx?.folders?.has(folder))
				await this.mkdirp(folder);
			fse.copyFile(source, destination, (err) => {
				err && reject(err) || resolve();
			});
		})
	}	

	// async replicateFolderGlob(pattern, options, iterator) {
	// 	let files = await this.glob(pattern, options, (err, files));
	// 	while(files) {
	// 		file
	// 	}
	// }


	matchFiles(folder, regex) {
		let list = [];
		let files = fs.readdirSync(folder);
		//console.log(folder,' -> files:',files);
		while(files.length) {
			let file = files.shift();
			var target = path.join(folder,file);
			//console.log('target:',target);
			if(fs.lstatSync(target).isDirectory()) {
				//console.log('concat',folder,file);

				list = list.concat(this.matchFiles(target,regex));
			} else {
				if(!regex || regex.test(target))
					list.push(target);
			}
		}
		//console.log('up', list);
		return list;
	}

	readI18nFile(filePath){
		if(!fs.existsSync(filePath))
			return [];
		let content = fs.readFileSync(filePath);
		let entries = JSON.parse(content);
		return this.sortI18nEntries(entries)
	}

	sortI18nEntries(entries){
		return entries.sort((objA, objB)=>{
			let a = objA.en;//.toLowerCase();
			let b = objB.en;//.toLowerCase();
			if(a<b)
				return -1

			if(a>b)
				return 1
			return 0
		})
	}

	cleanI18nEntries(entries){
		let map = new Map();
		entries.forEach(entry=>{
			if(!entry['en'])
				return
			Object.keys(entry).forEach(k=>{
				if(k == 'en')
					return;

				if(entry['en'] == entry[k])
					entry[k] = "";

				map.set(entry['en'], entry);
			})
		})
		return map;
	}

	readI18nEntries(folder="./", file="i18n.entries"){
		return this.readI18nFile(folder+file);
	}

	readI18nData(folder="./", file="i18n.data"){
		return this.readI18nFile(folder+file);
	}

	sortAndSaveI18nFiles(folder="./"){
		let items = this.readI18nFile(folder+"i18n.entries");
		fs.writeFileSync(folder+"i18n-sorted.entries", JSON.stringify(items, null, "\t"));
		items = this.readI18nFile(folder+"i18n.data");
		fs.writeFileSync(folder+"i18n-sorted.data", JSON.stringify(items, null, "\t"));
	}

	mergeI18nEntries2Data(skipSave=false, folder="./"){
		let entriesItems = this.readI18nEntries(folder);
		let entriesMap = this.cleanI18nEntries(entriesItems);
		let dataItems = this.readI18nData(folder);
		let dataMap = this.cleanI18nEntries(dataItems);

		//console.log("entriesMap", entriesMap)
		//console.log("dataMap", dataMap)

		let entry;
		entriesMap.forEach((localEntry, key)=>{
			entry = dataMap.get(key);
			if(!entry){
				dataMap.set(key, localEntry)
				return;
			}
		})

		let data = this.sortI18nEntries(Array.from(dataMap.values()));
		if(skipSave)
			return data;
		fs.writeFileSync(folder+"i18n-merge.data", JSON.stringify(data, null, "\t"));
	}




/*
	replicateFolder(source, target, filter) {
	    var files = [];

	    //check if folder needs to be created or integrated
	    var targetFolder = path.join(target,path.basename(source));
	    if (!fs.existsSync(targetFolder)) {

	    	let f = filter(targetFolder.replace(/\\/g,'/'));
	    	if(!f)
		    	return;

	        fs.mkdirSync(targetFolder);
	        // mkdirp(targetFolder);
	    }

	    //copy
	    if(fs.lstatSync(source).isDirectory()) {
			files = fs.readdirSync(source);
			while(files.length) {
				let file = files.shift();
	            var curSource = path.join(source,file);
	            if(fs.lstatSync(curSource).isDirectory()) {
	                this.digestFolderRecursiveSync(curSource,targetFolder,filter);
	            } else {
	                this.digestFileSync(curSource,targetFolder,filter);
	            }
	        }
	    }

	}
*/
}

if(!Number.prototype.toFileSize) {
	Object.defineProperty(Number.prototype, 'toFileSize', {
		value: function(a, asNumber) {
			var b,c,d;
			var r = (
				a=a?[1e3,'k','B']:[1024,'K','iB'],
				b=Math,
				c=b.log,
				d=c(this)/c(a[0])|0,this/b.pow(a[0],d)
			).toFixed(2)

			if(!asNumber) {
				r += ' '+(d?(a[1]+'MGTPEZY')[--d]+a[2]:'Bytes');
			}
			return r;
		},
		writable:false,
		enumerable:false
	});
}

module.exports = Utils;