"use strict";


const os = require('os');
const path = require('path');
const mkdirp = require('mkdirp');
const fs = require('fs');
const fse = require('fs-extra');
const isRoot = require('is-root');
const semver = require('semver')
const crypto = require('crypto');
const _ = require('underscore');
const NWJC = require('./nwjc');
const JSC = require('./jsc');
const Utils = require('./utils');
//const Go = require('./go');
const Toposort = require('toposort-class');
const { finished } = require('stream');
const timestamp = require('time-stamp');
const BASCII = require('bascii');

const PLATFORM = { win32 : 'windows', darwin : 'darwin', linux : 'linux' }[os.platform()];
const _ARCH_ = os.arch();
const ARCH = (_ARCH_ == 'arm') ? _ARCH_+process.config.variables.arm_version : _ARCH_;

function dpc(t,fn) { if(typeof(t) == 'function') setImmediate(t); else setTimeout(fn,t); }
global.dpc = dpc;

class Core {

	constructor(appFolder, options) {
		this.appFolder = appFolder;
		if(!this.appFolder)
			throw new Error("Missing appFolder in Emanator options");
		this.utils = new Utils(this);
		this.flags = this.utils.args();

		if(!options.type)
			options.type = 'UTIL';
		if(!options.ident)
			options.ident = 'util';

		this.options = options = Object.assign({
			type : 'UTIL',
			ident : 'util'
		}, options);

		if(this.flags.archive && !options.archive)
			options.archive = true;
		if(this.flags.DMG && !options.DMG)
			options.DMG = true;			

		this.options = options;

		this.bascii = new BASCII('cybermedium');
		if(options.banner)
			this.print(options.banner);

		// if(!options.git && !options.upload)
		// 	throw new Error("missing options.git (git) URL for repository source");
		this.type = { }
		options.type.split('+').forEach(t=>this.type[t]=true);
		// this.type[options.type] = true;
		this.PROJECT_VERSION = options.version;
		this.NODE_VERSION = process.versions.node;

		this.HOME = os.homedir();
		if(this.flags.lgwebos) {
			this.PLATFORM = 'webos';
			this.ARCH = 'lg';
		} else {
			this.PLATFORM = PLATFORM;
			this.ARCH = ARCH;
		}
		this.PLATFORM_ARCH = `${this.PLATFORM}-${this.ARCH}`;
		this.PLATFORM_BINARY_EXTENSION = this.BINARY_EXT = (this.PLATFORM == 'windows' ? '.exe' : '');
		this.BINARY = (filename)=>{ return filename+this.PLATFORM_BINARY_EXTENSION; }
		this.WINCMD_EXT = (this.PLATFORM == 'windows' ? '.cmd' : '');
        this.PLATFORM_PATH_SEPARATOR = this.PLATFORM == 'windows' ? ';' : ':';
		this.ident = options.ident;
		this.title = options.title;
		this.name = options.ident;
		this.identUCFC = options.ident.charAt(0).toUpperCase()+options.ident.slice(1);
		this.DMG_APP_NAME = options.DMG_APP_NAME || this.title || this.identUCFC;
		this.DMG_APP_NAME_ESCAPED = this.DMG_APP_NAME.replace(/\s/g,`\\ `)
		this.identUC = options.ident.toUpperCase();
		this.suffix = options.suffix || '';

		this.firewallRules = [ ];
		if(options.firewall === true)
			this.registerFirewallRule('app');
		//this.gulp = gulp;
		this.JSC = new JSC(this);

		if(options.nwjs) {
			this.NWJS_VERSION = 'v'+options.nwjs.version;
			this.NWJS_VERSION_NO_V = options.nwjs.version;
		}
		else if(options.type == 'NWJS' && (!options.nwjs || !options.nwjs.version)) {
			console.log(`Error: emanator build type is 'NWJS' but 'options.nwjs.version' is missing`);
			process.exit(1);
		}


		[
			'download', 'unzip', 'zip', 'extract', 'spawn', 'exec',
			'copy', 'move', 'remove', 'mkdirp', 'emptyDir', 'ensureDir', 'addToPath'
		].forEach((fn) => { 
			this[fn] = this.utils[fn].bind(this.utils); 
		})

		this.modules = { }
		fs.readdirSync(path.join(__dirname,'modules')).forEach((t_with_ext) => {
			if(/^\./.test(t_with_ext)) // skip files starting with .
				return;
			//console.log('processing module',t_with_ext);
			const t = t_with_ext.replace(/\.js$/ig,'');
			if(fs.existsSync(path.join(__dirname,'modules',t,`${t}.js`)))
				this.modules[t] = require(`./modules/${t}/${t}.js`).Resolver(this);
			else
				this.modules[t] = require(`./modules/${t}`).Resolver(this);
		})


		this.packageJSON = null;

		this.NWJS_SUFFIX = { windows : 'win', darwin : 'osx', linux : 'linux' }[PLATFORM];
		//this.NWJS_ARCHIVE_EXTENSION = { windows : 'zip', darwin : 'zip', 'linux' : 'tar.gz' }[PLATFORM];
		this.NWJS_ARCHIVE_EXTENSION = { windows : 'zip', darwin : 'zip', 'linux' : 'tar.gz' }[PLATFORM];
		this.NODE_ARCHIVE_EXTENSION = { windows : 'zip', darwin : 'tar.gz', 'linux' : 'tar.gz' }[PLATFORM];
		this.NPM = { windows : 'npm.cmd', darwin : 'npm', 'linux' : 'npm' }[PLATFORM];

		if(options.innosetup && PLATFORM == "windows" && !fs.existsSync("C:/Program Files (x86)/Inno Setup 6/compil32.exe")) {
			console.log("Unable to find Inno Setup binaries...".brightRed);
			console.log("https://jrsoftware.org/".brightYellow);
			process.exit(1);
		}


		let { baseUrl, organization, project } = this.utils.match(this.options.git,/(?<baseURL>(git@|\w+@|https:\/\/)[\w-]+\.\w+[:\/])(?<organization>[\w]+)\/(?<project>[\w]+)(\.git)?/);

		if(!organization)
			organization = this.options.author;

		let rootFolder = (organization && project) ? [organization,project+'/'] : [this.ident+'/'];

		var args_ = process.argv.join(' ');
		// this.flags = { }
		// _.each(['init','reset','clean','force','release','rc','verbose','dbg','nonpm','nonwjc','fast','nopackage','local-binaries'], (v) => {
		// 	this.flags[v] = (~args_.indexOf('--'+v) || ~args_.indexOf('---'+v)) ? true : false;
		// })

		let args = this.args = process.argv.slice(2);
		this.argv = args;

		// folders
		const RELEASE = this.options.BASE || path.join(this.HOME,'emanator');
		const TOOLS = path.join(RELEASE,'tools');
		const DEPS = path.join(RELEASE,'deps');
		const SETUP = path.join(appFolder,(options.destination||'setup'),this.PLATFORM_ARCH);
		const ROOT = path.join(RELEASE,...rootFolder);
		const TEMP = path.join(ROOT,'temp');
		const DMG = path.join(ROOT,"DMG");
		const folders = {
			RELEASE,
			TOOLS,
			DEPS,
			SETUP,
			ROOT,
			TEMP,
			DMG,
		}
		// this.SETUP = path.join(this.RELEASE,'setup');
		this.targetDMG = null;
		
		if(this.flags['release'])
			folders.REPO = path.join(ROOT,'repo');
		else
			folders.REPO = path.join(this.appFolder);

		this.folders = folders;
		Object.entries(folders).forEach(([k,v]) => { this[k] = v; })

		if(this.flags.verbose) {
			this.log(`working in`,this.ROOT.bold);
			this.log(`destination is`,this.SETUP.bold);
		}

		this.createFolders();

		let branchIdx = args.indexOf('--branch');
		if(branchIdx > -1) {
			this.gitBranch = args[branchIdx+1];
		}

		if(this.flags.debug || this.flags.dbg)
			this.flags.debug = this.flags.dbg = true;


		this.tasks = { 
			root : [
				// 'clean',
				'init',
				this.flags.release && 'clone',
				'manifest-read',
				'create-folders',
				'manifest-write',
				'npm-install',
				//{'package-write' : 'package-json'},
				//{'npm-install' : 'package-write' },
				'npm-update',
				'nwjs-sdk-download',
				'nwjs-ffmpeg-download',
				'nwjs-download',
				'nwjs-sdk-unzip',
				'nwjs-ffmpeg-unzip',
				'nwjs-unzip',
				'unlink-nwjs-app',
				'nwjs-copy',
				'nwjs-ffmpeg-copy',
				'nwjs-cleanup',
				'node-modules',
				'node-binary',
				'origin'
			].filter(v=>v),
			application : [ ]
		}

		this.tasks.root = this.tasks.root.filter((task) => {
			if(_.isObject(task))
				return true;
			if(!this.type.NWJS && !this.flags['nwjs-sdk'] && task.match(/nwjs/ig))
				return false;
			return true;
		})

		// this.plugins = {
		// 	cleanCSS, minifyHTML
		// }

		this.clean();
	}

	createFolders() {
		if(!this.options.skipDirCreation)
			[this.RELEASE,this.TOOLS,this.ROOT,this.DEPS,this.TEMP,this.SETUP].forEach((folder) => {
				mkdirp.sync(folder);  
			});
	}

	runTask(task_) {
		return new Promise((resolve,reject) => {
			let task = this.registry[task_];
			if(!task)
				return reject(`task '${task_}' not found`);
			let wrap = task.args.pop();
			wrap((err, result) => {
				return err ? reject(err) : resolve(result);
			})
		})
	}

	async run(list) {
		dpc(()=>{
			this.run_(list);
		})
	}

	async run_(list_) {

		if(!list_){
			if(PLATFORM == "darwin" && !isRoot() && this.options.DMG) {
				console.log("\n\nMust run as root!\n\nuseage: sudo emanate\n".red.bold);
				process.exit(1);
			}
		}
		
		dpc(()=>{
			this.log('');
			let padding = Object.keys(this.options).map(v => v.length).reduce((a,v) => Math.max(v,a));
			Object.keys(this.options).map(k => [k,this.options[k]]).forEach(([k,v]) => {
				if(typeof v == 'function')
					return;
				if(typeof v == 'object')
					v = Object.entries(v).map(([k,v])=>{ 
						v = JSON.stringify(v).replace(/^"|"\s*$/g,'');
						return `${k}: ${v}`; 
					}).join(' ');
				this.log(`${k}:`.padStart(padding+1,' '),(v+'').brightWhite);
			})
			this.log('');

			this.sealing = true;
			this.tasks.platform.unshift(this.lastUserTask || 'done');
			let tasks = [].concat(this.tasks.root, this.tasks.application, this.tasks.platform);
			this.flags.debug && console.log(tasks);
			let prev = null;
			_.each(tasks, (v) => {
				if(typeof(v) == 'string') {
					if(v == this.lastUserTask || v == 'done') {
						prev = v;
						return;
					}
					if(prev)
						this.task(v, [prev]);
					else
						this.task(v);
					prev = v;
				}
				else
				if(_.isObject(v)) {
					_.each(v, (value, key) => {
						this.task(key, [value]);

					})
				}
			})

			this.task('upload', [], this.upload.bind(this));
			this.task('default',this.tasks.platform);

			// console.log(Object.keys(this.registry));

			this.generateTasks_(list_);
		})
	}

	async generateTasks_(list_) {
		var self = this;

		let t = new Toposort();
		if(list_){
			let added = {};
			let addTask = (list)=>{
				list.forEach(ident=>{
					if(added[ident])
						return
					added[ident] = true;
					let v = this.registry[ident];
					if(v && v.deps && v.deps.length){
						t.add(ident, v.deps);
						addTask(v.deps);
					}
				})
			}

			addTask(list_);
		}else{
			_.each(this.registry, (v,k) => {
				if(v.deps && v.deps.length)
					t.add(k, v.deps);
			})
			
		}
		t = t.sort().reverse();
		let total = t.length;

		this.log("Generated Tasks:", t)

		this.pendingTasks_ = t;

		let nameLength = t.length ? t.map(t => t.length).reduce((a,v) => Math.max(v,a))+5 : 0;
		// console.log("nameLength".cyan.bold,nameLength);
		const digest = async (cb) => {
			let ident = t.shift();
			if(!ident)
				return cb();
		//console.log("DIGEST for".cyan.bold,ident.bold,"REMAINING:".yellow.bold,t);
			let task = self.registry[ident];
			this.options.debugTask && this.log(`${ident}::started...`.green.bold)
			if(!task) {
				this.options.debugTask && this.log(`${ident}::not found...`.red.bold, task)
				return cb();
			}

			let ts0 = Date.now();
			let handler = (err) => {
				this.options.debugTask &&  this.log(`${ident}::ended`.green.bold)
				let tdelta = Date.now() - ts0;
				if(err) {
					console.log(`Error while processing`.red.bold,`${ident}`.bold);
					console.log(err);
					throw new Error('Aborting...');
				}
				digest(cb);
			}

			let descr = ident;
			if(ident == 'done')
				descr = 'user tasks done';
			else
			if(ident == 'default')
				descr = 'done';


			let progress = `...${((1.0-t.length/total)*100).toFixed(2)}% [${total-t.length}/${total}]`;
			this.log((descr+'...').padEnd(process.stdout.columns-11-progress.length)+progress.grey);//,'...'+t.join(' '));
			let fn = task.args.pop();

			let p = fn(handler);
		}

		digest(()=>{
			// console.log("all done...".yellow.bold)
		})
	}

	task(ident, deps, fn) {

		if(typeof deps == 'function') {
			fn = deps;
			deps = null;
		}

		if(!this.sealing)
			this.lastUserTask = ident;

		if(!fn)
			fn = this[ident.replace(/-/g,'_')];
		if(!fn && ident != 'default')
			fn = cb => cb();

		let $args = deps ? [deps] : [];
		let wrap = async (...args) => {
			let cb = args.pop();
			if(!fn)
				return cb();
			let closure = (...cbargs)=>{
				//console.log(`${ident} finished...`.green.bold);
				return cb(...cbargs);
			}
			var called = false;
			let pclosure = (...cbargs)=>{
				//console.log(`${ident} P::finished...`.green.bold);
				if(called)
					return
				called = true;
				return cb(...cbargs);
			}

			args.push(closure);
			let p = fn.call(this, ...args);

			if(p && p._readableState) {
				// detect streams and trigger callback on their completion
				p.on("finish", ()=>{
					//console.error(`${ident} finished.`.red);
					pclosure();
				})
				/*
				p.on("close", (err)=>{
					//console.error(`${ident} closed.`.red, err);
					pclosure();
				})
				*/
				p.on("error", (err)=>{
					//console.error(`${ident} error.`.red, err);
					pclosure();
				})
				p.on("end", (err)=>{
					//console.error(`${ident} end.`.red, err);
					pclosure();
				})
				
				/*
				finished(p, (err) => {
					console.error(`${ident} finished.`.red);
				  if (err) {
				    console.error('################# Stream failed.'.red, err);
				  } else {
				    console.log(`${ident} Stream is done.`);
				    console.log(`${ident} has closure!`.magenta.bold)
					pclosure();
				  }
				});
				*/
			}
			else
			if(p && typeof(p.then) == 'function') {
				// block this task completion
				//console.log(`${ident} - await...`.red.bold,p);
				await p;
				//console.log(`...${ident} - done...`.green.bold);
				return cb()
			}
		}

		$args.push(wrap);

		if(!this.registry)
			this.registry = { }

		if(this.registry[ident])
			throw new Error(`error - duplicate task '${ident}'`);
		let d = deps ? deps.slice() : null;
		this.registry[ident] = { ident, deps : deps, args : $args.slice(), deps_ : d }

		return fn;
	}

	log(...args) {
		process.stdout.write('['+timestamp('HH:mm:ss').grey+'] ');
		console.log(...args);
	}

	clean() {

		if(this.flags.clean) {
			this.log('cleaning',this.ROOT.bold);
			fse.emptyDirSync(this.ROOT);
		}
		else
		if(this.flags.reset) {
			this.log('cleaning',this.RELEASE.bold);
			fse.emptyDirSync(this.RELEASE);
			this.createFolders();
		}
	}

	init(callback) {

		// this.SETUP

		// [this.RELEASE,this.TOOLS,this.ROOT,this.DEPS,this.TEMP].forEach((folder) => {
		// 	mkdirp.sync(folder);  
		// });
		callback();
	}

	async clone() {
		console.log('clone');
		// console.log("GIT REPO IS:",this.REPO);
		// process.exit(0);
		if(!this.flags.release)
		 	return Promise.resolve();

		const stdout_ = (data) => { process.stdout.write(data); }
		const stderr_ = (data) => { process.stderr.write(data); }

		const stdio = ['inherit', stdout_, stderr_];

		if(fs.existsSync(this.REPO)) {
			this.log("Git repository is present...\nChecking integrity...");

			let code = await this.utils.spawn('git',['fsck'], { cwd : this.REPO, stdio : 'inherit', resetTTY : true });
			if(code) {
				console.log(`git error code: ${code}`);
				process.exit(code);
			}

			code = await this.utils.spawn('git',['pull'], { cwd : this.REPO, stdio : 'inherit', resetTTY : true });//, (err, code) => {
			if(code) {
				console.log(`git error code: ${code}`);
				process.exit(code);
			}

		}
		else {
			let args;
			if(this.gitBranch)
				args = ['clone','--single-branch','--branch',this.gitBranch,this.options.git,'repo'];
			else
				args = ['clone',this.options.git,'repo'];

			let code = await this.utils.spawn('git',args, { cwd : this.ROOT, stdio : 'inherit', resetTTY : true });//, (err, code) => {

			if(this.PLATFORM == 'darwin') {
				try {
					await this.utils.spawn(`chmod`,['a+rw','repo'], { cwd : this.ROOT, stdio : 'inherit' });
				} catch(ex) {
					console.log(ex);
					throw "Unable to run chmod on repo folder";
				}
			}
		}

	}

	manifest_read_sync() {

		let pathToPackageJSON = path.join(this.package(this.REPO),'package.json');
		if(fs.existsSync(pathToPackageJSON)) {
			this.manifest = this.packageJSON = JSON.parse(fs.readFileSync(pathToPackageJSON).toString());
			// this.name = this.packageJSON.name;

			if(this.options.manifest)
				this.manifest = this.options.manifest(this.manifest);

			this.PROJECT_VERSION = this.PROJECT_VERSION || this.manifest.version;

			this.log('package version:', this.PROJECT_VERSION);
		}
		else {
			console.log("Error reading manifest from:".brightRed, pathToPackageJSON);
			// this.manifest = {
			// 	version : 
			// }
		}
	}
	manifest_read() {
		this.manifest_read_sync();
		return Promise.resolve(this.manifest);
	}

	create_folders(callback) {

		let folder = this.options.folder;
		if(folder === true)
			folder = '$IDENT-v$VERSION-$PLATFORM-$ARCH';

		if(folder)
			this.BUILD = path.join(this.ROOT,'build',this.resolveStrings(folder));
		else
			this.BUILD = path.join(this.ROOT,'build');
		//mkdirp.sync(this.BUILD);

		// if(this.type.NWJS)
		// 	this.PACKAGE = path.join(this.BUILD,'package.nw');
		// else
			this.PACKAGE = this.package(this.BUILD);

		if(this.flags['local-binaries'])
			this.BIN = path.join(this.appFolder,'bin',this.PLATFORM_ARCH);
		else
			this.BIN = path.join(this.PACKAGE,'bin',this.PLATFORM_ARCH);


		[this.BUILD,this.PACKAGE,this.BIN].forEach((folder) => {
			// console.log("creating folder:",folder);
			mkdirp.sync(folder);  
		});

		// else
		// 	this.name = this.options.name;
		//this.
		//this.projectName = this.pa
		// console.log("packageJSON:",this.packageJSON);
		// this.packageTOOLS = JSON.parse(fs.readFileSync(path.join(this.appFolder,'package.json')));
		/*if(!this.packageJSON['gulp-config'])
		  throw new Error("package.json must contain 'gulp-config' property");

		let config = this.packageJSON['gulp-config'][this.PLATFORM_ARCH] || this.packageJSON['gulp-config']['*'];
		if(config) {
			console.log(`WARN: package.json 'gulp-config' property does not have an entry for`.magenta.bold, `${this.PLATFORM_ARCH}`.bold);

			this.NWJS_VERSION = 'v'+config['nwjs-version'];
			this.NWJS_VERSION_NO_V = config['nwjs-version'];

			//this.NODE_VERSION = 'v'+this.packageJSON['gulp-config']['node-version'];
			this.targetDMG = 'setup/'+this.ident+'-darwin-'+this.packageJSON.version+this.suffix+'.dmg';
		}
		*/
		// if('v'+this.NODE_VERSION != process.version) {
		//   console.log("Please change node to:".magenta.bold,this.NODE_VERSION.bold,"or make appropriate changes in".magenta.bold,"package.json".bold);
		//   process.exit(1);
		// }

		// TODO - MOVE NWJS INIT INTO A SEPARATE TASK
		// NWJC needs to have NWJS_VERSION;  TODO - move to separate task
		if(this.type.NWJS)
			this.NWJC = new NWJC(this); //{ ROOT : this.PACKAGE, DEPS : this.DEPS, NWJS_VERSION : this.NWJS_VERSION, NWJS_SUFFIX : this.NWJS_SUFFIX });

		callback();
	}

	manifest_write(callback) {

		if(!this.packageJSON)
			return callback();

		this.packageJSON["release-type"] = this.flags.release ? "release": "developer";

		Object.keys(this.packageJSON).forEach((k) => {
			let o = this.packageJSON[k][this.ident];
			if(o)
				this.packageJSON[k] = o;
		})

		if(this.JSC.enable) {
			this.packageJSON.dependencies['bytenode'] = "*"
		}

		fs.writeFileSync(path.join(this.PACKAGE, "package.json"), JSON.stringify(this.packageJSON,null,'\t'));
		// fs.writeFileSync(path.join(this.REPO, "package.json"), JSON.stringify(this.packageJSON,null,'\t'));

		callback();
	}

	async npm_install() {
		this.log('npm running in',this.PACKAGE);
		if(this.options.nonpm || this.flags.nonpm || this.flags['dry-run'])
			return;
		let args = ['install'];
		if(this.options.production || this.flags.production)
			args.push('--omit=dev');

		return this.utils.spawn(this.NPM, args, { cwd : this.PACKAGE, stdio : 'inherit' });
		//callback();
	}

	async npm_update() {
		if(this.options.nonpm || this.flags.nonpm || this.flags['dry-run'])
			return;

		return this.utils.spawn(this.NPM, ['update'], { cwd : this.PACKAGE, stdio : 'inherit' });
	}

/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////

	async nwjs_ffmpeg_download() {
		if(!this.options.nwjs?.ffmpeg)
			return;
		// https://github.com/iteufel/nwjs-ffmpeg-prebuilt/releases
		let file = `${this.NWJS_VERSION_NO_V}-${this.NWJS_SUFFIX}-x64.zip`
		let url = `https://github.com/iteufel/nwjs-ffmpeg-prebuilt/releases/download/${this.NWJS_VERSION_NO_V}/${file}`;
		return this.utils.download(url,path.join(this.DEPS,file));
	}

	async nwjs_ffmpeg_unzip() {
		if(!this.options.nwjs?.ffmpeg)
			return;
		if(this.flags.fast)
			return;

		let file = `${this.NWJS_VERSION_NO_V}-${this.NWJS_SUFFIX}-x64.zip`;
		return this.utils.unzip(path.join(this.DEPS,file), this.DEPS, { overwrite : true });//, callback);
	}

	nwjs_ffmpeg_copy(callback) {
		if(!this.options.nwjs?.ffmpeg)
			return callback();

		switch(process.platform) {
			case 'win32' : {
				console.log("copying",path.join(this.DEPS,"ffmpeg.dll"),"to",path.join(this.BUILD,'ffmpeg.dll'));
				return this.copy(path.join(this.DEPS,"ffmpeg.dll"),path.join(this.BUILD,'ffmpeg.dll'));
			} break;

			case 'linux':{
				return this.copy(path.join(this.DEPS,"libffmpeg.so"),path.join(this.BUILD,"lib","libffmpeg.so"));
			}
			case 'darwin': {
				var versions = path.join(this.BUILD,'nwjs.app/Contents/Frameworks/nwjs Framework.framework/Versions');
				var list = fs.readdirSync(versions);
				this.utils.asyncMap(list, (v, next) => {
					fse.copy(
						path.join(this.DEPS, "libffmpeg.dylib"),
						path.join(versions, v, "libffmpeg.dylib"),
						{overwrite:true},
						next
					);
				}, callback);
			} break;
		}
	}

	async nwjs_sdk_download() {
		let file = `nwjs-sdk-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64.${this.NWJS_ARCHIVE_EXTENSION}`
		let url = `https://dl.nwjs.io/${this.NWJS_VERSION}/${file}`;
		return this.utils.download(url,path.join(this.DEPS,file));
	}

	async nwjs_download() {
		let file = `nwjs-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64.${this.NWJS_ARCHIVE_EXTENSION}`
		let url = `https://dl.nwjs.io/${this.NWJS_VERSION}/${file}`;
		return this.utils.download(url,path.join(this.DEPS,file));
	}

	async nwjs_sdk_unzip() {
		if(this.flags.fast)
			return;

		let file = `nwjs-sdk-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64.${this.NWJS_ARCHIVE_EXTENSION}`;
		await this.utils.unzip(path.join(this.DEPS,file), this.DEPS, { overwrite : true });
	}

	async nwjs_unzip(callback) {
		if(this.flags.fast)
			return;

		let file = `nwjs-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64.${this.NWJS_ARCHIVE_EXTENSION}`;
		return this.utils.unzip(path.join(this.DEPS,file),this.DEPS, { overwrite : true });
	}

	unlink_nwjs_app(callback) {
		let appFile = path.join(this.BUILD, 'nwjs.app');
		if(!fs.existsSync(appFile)){
			callback()
		} else {
			fse.remove(appFile, function(){
				callback()
			});
		}
	}

	nwjs_copy(callback) {
		let folder = path.join(this.DEPS,`nwjs-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64`);
		if(this.flags['nwjs-sdk'])
			folder = path.join(this.DEPS,`nwjs-sdk-${this.NWJS_VERSION}-${this.NWJS_SUFFIX}-x64`);
		if(PLATFORM == "darwin")
			return this.spawn('cp', ['-R', folder+"/.", this.BUILD], { cwd : this.BUILD, stdio: 'inherit' });
// v5
		return this.copy(path.join(folder,"/"),this.BUILD);
	}

	nwjs_cleanup(callback) {
		if(fs.existsSync(path.join(this.BUILD,'credits.html')))
			fse.move(path.join(this.BUILD,'credits.html'),path.join(this.BUILD,'chrome_credits.html'),{ overwrite : true },callback); 
	}

/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////

	/*
	node_modules(callback) {
		if(this.options.nonpm)
			return callback();
		
	    return gulp.src(path.join(this.REPO,'/node_modules/**'))
	    .pipe(gulp.dest(path.join(this.PACKAGE,'/node_modules/')));
	}*/

	node_binary(callback) {
		let standalone = false;
		if(typeof this.options.standalone == 'function')
			standalone = this.options.standalone();
		else
			standalone = this.options.standalone;

		if(!standalone || !this.type.NODE)
			return callback();
		console.log("copying node binary",this.options);
		let file = this.PLATFORM == 'windows' ? 'node.exe' : 'node';
		let target = path.join(this.PACKAGE,file)
		let node_binary = process.argv[0];
		if(this.options?.node && this.options.node[this.PLATFORM])
			node_binary = path.join(E.appFolder,this.options.node[this.PLATFORM]);
		// console.log('copy',node_binary,'->',target);
    	fse.copy(node_binary, target, callback);
	}

	polymer(callback) {
		if(this.options.nopolymer)
			return callback();
	}

	// ---

    async upload() {
		// _.extend(this, this.utils.getConfig('upload'));
		if(!this.options.scp)
			return Promise.resolve();
        
        let maxVer = '0.0.0';
        var list = fs.readdirSync(this.SETUP);
        var latestFile = null;
        _.each(list, (f) => {
        	console.log(f);
            if(f.indexOf(this.ident) != 0)
                return;

            // if(/-darwin-/.test(f) == false && /-windows-/.test(f) == false)
            //     return;

            // let parts = f.replace(this.ident+"-darwin-", "").replace(this.ident+"-windows-", "").split('.');
            // parts.pop();// extension
			// let version = parts.join('.');
			
			let { version } = this.utils.match(f,/(?<version>\d+\.\d+\.\d+)/);
			if(!version)
				return;

            if(semver.gt(version, maxVer)) {
                maxVer = version;
                latestFile = f;
            }
        })

        if(latestFile) {

            let hash = this.createHash_(latestFile);
                // if(err)
                //     return console.log("CreateHash:Error", err);

			var hashFileName = this.createHashFile_(latestFile, hash);
			console.log(hashFileName, "- hash: "+hash.green.bold)

			return this.uploadFiles_(hashFileName, latestFile);
        }
        else {
            return Promise.reject("Unable to locate setup file! aborting...");
        }
    }

    async createHash_(file) {
		return new Promise((resolve,reject)=>{
			var sha1 = crypto.createHash("sha1");
			sha1.setEncoding('hex');
			let input = fs.createReadStream(path.join(this.SETUP, file));
			input.on('end', function() {
				sha1.end();
				var hash = sha1.read();
				resolve(hash);
			});
			input.pipe(sha1);
		})
    }

    createHashFile_(fileName, hash){
        var hashFileName = fileName.split(".");
        hashFileName.pop();
        hashFileName.push("sha1")
        hashFileName = hashFileName.join(".");

        fs.writeFileSync(path.join(this.SETUP, hashFileName), hash);
        return hashFileName;
    }

    async uploadFiles_(hashFile, setupFile) {
		let args = [ ]

		let scp = this.options.scp;
		if(scp.port)
	        args.push('-P',scp.port);
        args.push(hashFile, setupFile);
        args.push(scp.dest || scp);
        console.log(args);
        // return;

        return this.utils.spawn('scp', args, { cwd : this.SETUP, stdio : 'inherit' });
    }

	async scp(dest) {
		console.log(`scp ${this.ARCHIVE} ${dest}`.bold);
        return this.utils.spawn('scp', [this.ARCHIVE, dest], { cwd : this.SETUP, stdio : 'inherit' });
	}

    resolveStrings(t, custom = { }) {
		let strings = {
			'IDENT' : this.ident,
			'NAME' : this.ident,
			'TITLE' : this.title,
			//'NAME' : this.packageJSON.name,
			'VERSION' : this.PROJECT_VERSION,
			'NWJS-VERSION' : this.NWJS_VERSION_NO_V,
			'NWJS-SUFFIX' : this.NWJS_SUFFIX,
			'NWJS-PLATFORM' : this.NWJS_SUFFIX,
			'NODE-VERSION' : this.NODE_VERSION,
			'PLATFORM' : this.PLATFORM,
			'ARCH' : this.ARCH,
			'PLATFORM-ARCH' : this.PLATFORM_ARCH,
			'SUFFIX' : this.suffix,
		};

		Object.assign(strings,custom);

		Object.entries(strings).forEach(([k,v]) => {
			t = t.replace(new RegExp('\\$'+k,'ig'), v);
		})

		return t;
    }

	archive() {
		return new Promise(async (resolve,reject) => {

			if(!this.options.archive)
				return resolve();

			// if(this.options.archive === undefined || this.options.archive === false)
			// 	return resolve();

			//const isFolder = this.options.archiveFolder ? true : false;

			console.log("Preparing to archive...");
			let archive = this.options.archive || this.ident;
			let level = this.options.archiveLevel !== undefined 
					&& this.options.archiveLevel >= 0 
					&& this.options.archiveLevel <= 9 
					? this.options.archiveLevel : 6;

			if(archive === true)
				archive = '$IDENT$SUFFIX-v$VERSION-$PLATFORM-$ARCH';

			archive = this.createArchiveName(archive);

			this.ARCHIVE_FILENAME = archive;
			this.ARCHIVE_LEVEL = level;

			let target = path.join(this.SETUP,archive);
			if(fs.existsSync(target))
				fs.unlinkSync(target);

			this.ARCHIVE = target;
			let code = await this.createArchive();
			// let code = await this.utils.spawn('zip',['-qdgds','10m','-r', `${target}`, './'], {
			// 	cwd : this.options.folder ? path.join(this.ROOT,'build') : this.BUILD,
			// 	stdio : 'pipe',
			// 	stdout : (data) => { process.stdout.write(data.toString().replace(/\r|\n/g,'')); }
			// });
			process.stdout.write('\n');
				//let target = path.join(this.BUILD,archiveFile);
			let stat = fs.statSync(target);

			if(!stat || !stat.size) {

				console.log(`${archive} is done - (please check target file - can not get file stat!)`)
			}
			else {
				console.log(`${target}`)
				console.log(`${archive} - ${stat.size.toFileSize()} - Ok`)
			}

			let hash = await this.utils.fileHash(target, 'sha1');
			let hashFile = target+'.sha1sum';
			fs.writeFileSync(hashFile, hash);
		
			resolve();
		});
	}

	createArchiveName(archive){
		archive = this.resolveStrings(archive, {
		 	'EXTENSION' : 'zip'
		});

		if(!archive.match(/\.zip$/))
			archive += '.zip';
		return archive;
	}

	createArchive(){
		return this.utils.zipFolder(
			this.options.folder ? path.join(this.ROOT,'build') : this.BUILD,
			this.ARCHIVE,
			this.ARCHIVE_LEVEL
		);
	}

	print(...args) {
		this.bascii.print(...args);
	}

	package(f) {
		return this.options.package ? path.join(f,this.options.package) : f;
	}

	registerFirewallRule(args) {
		this.firewallRules.push(args);
	}
}


module.exports = Core;
