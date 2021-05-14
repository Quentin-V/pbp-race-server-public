const PusherServer = require('pusher');
const PusherClient = require('pusher-js');
const options = require('./options.js')
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const app = require('express')();
const getLevelProgress = require('./levelProgress.js');

const races = [];
const SecretToParticipant = new Map();
const ParticipantToGameInfos = new Map();

const pusherS = new PusherServer({
	appId: options.app_id,
	key: options.key,
	secret: options.secret,
	cluster: options.cluster,
	useTLS: false
});
const pusherC = new PusherClient(options.key, {
	cluster: options.cluster
});

const port = options.PORT;
const COUNTDOWN = options.countdown || 15;

app.set('view engine', 'pug');
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
	res.send('Nothing to see here');
});

// region Everything view related

app.get('/test', (req, res) => {
	res.render('test', {title: 'Hey', message: 'This is the test'});
});

app.get('/viewraces', (req, res) => {
	res.render('races', {races : races});
});

app.get('/viewrace/:racename', (req, res) => {
	if(req.params.racename === undefined) {
		res.status(400);
		return res.send({error: "Please provide a racename"});
	}
	let theRace = races.find(r => r.name === req.params.racename);
	if(theRace === null || theRace === undefined) {
		res.status(404);
		return res.send({error: "Unable to find a race with the provided name"});
	}
	res.status(200)
	return  res.render('race', {race: theRace, infos: getRaceInfos(theRace)})
});

// endregion

// region API

app.post('/create', (req, res) => {
	if(req.body.name) {
		if(races.find(p => p.name === req.body.name)) {
			res.status(409);
			res.send({error: "A race with this name already exists", list : races});
		}else {
			res.status(200);
			res.send({success: "Your race has been added to the race list"});
			races.push(new Race(req.body.name));
			let chan = pusherC.subscribe(req.body.name);
			channelBinds(chan);
		}
	}else {
		res.status(400);
		res.send(new MissingParameterError("name"));
	}
});

app.delete('/delete/:racename', (req, res) => {
	if(!req.params.racename) {
		res.status(400);
		return res.send({error: "Please specify a race name"});
	}
	let theRace = races.find(r => r.name === req.params.racename);
	if(theRace === null) {
		res.status(400);
		return res.send({error: "The race you specified wasn't found"});
	}
	let indexDel = races.indexOf(theRace);
	races.splice(indexDel, 1);
	return res.status(200).send({error: "-Race deleted with success"})
});

app.post('/edit/:racename', (req, res) => {
	if(!req.params.racename) {
		res.status(400);
		return res.send({error: "Please specify the race you want to edit"});
	}
	let toEdit = races.find(r => r.name === req.params.racename);
	if(toEdit === null) {
		res.status(400);
		return res.send({error: "The race you specified does not exists"});
	}
	if(req.params.name) toEdit.name = req.params.name;
});

app.post('/join', (req, res) => {
	if(req.body.racename && req.body.username && req.body.twitch) {
		let theRace = races.find(r => r.name === req.body.racename);
		if(!theRace) {
			res.status(400);
			return res.send({error: "The race name you specified does not exists"});
		}
		if(theRace.started) {
			res.status(400);
			return res.send({error: "The race is already started"});
		}
		if(theRace.participants.find(p => p.name === req.body.username)) {
			res.status(400);
			return res.send({error: "A user with this name is already in this race"})
		}
		let part = new Participant(req.body.username, req.body.twitch);
		theRace.addParticipant(part);
		res.status(200);
		let secret = uuidv4();
		SecretToParticipant.set(secret, part);
		pusherS.trigger(theRace.name, "new-racer", {
			name  : part.name,
			twitch: part.twitch,
			ready : part.ready
		});
		let chan = pusherC.subscribe(secret);
		bindSecret(chan);
		return res.send({success: "You successfully joined this race", secret: secret});
	}else {
		let missing = [];
		if(!req.body.racename) missing.push("racename");
		if(!req.body.username) missing.push("username");
		if(!req.body.twitch) missing.push("twitch");
		res.status(400);
		res.send(new MissingParameterError(missing));
	}
});

app.get('/list', (req, res) => {
	res.status(200);
	res.send(races);
});

app.get('/race/:racename', (req, res) => {
	if(req.params.racename === undefined) {
		res.status(400);
		return res.send({error: "You did not specify a racename"});
	}else {
		let theRace = races.find(r => r.name === req.params.racename);
		if(theRace === null) {
			res.status(400);
			return res.send({error: "The race you asked for does not exists"});
		}
		res.status(200);
		res.send(theRace);
	}
});

app.get('/populate', (req, res) => {
	let raceNames = ['SuperRace', 'NewRace', 'WowCestPBP', 'JeVaisPasGagner'];
	let parts = ['Cakeri', 'Nartax', 'Jackey', 'Hankiou', 'Magic', 'Sliated', 'Alkyyu', 'Quinta'];
	raceNames.forEach(rn => races.push(new Race(rn)));
	races.forEach(r => {
		let cp = parts.slice();
		for(let i = 0; i < Math.floor((Math.random()* 4)+2); ++i) {
			let name = cp.splice(Math.floor(Math.random() * cp.length), 1)[0];
			r.participants.push(new Participant(name, name));
		}
	});
	res.send("Successfuly populated");
});

// endregion

const server = app.listen(process.env.PORT || port || 3000, function(){
	console.log('Listening on port ' + server.address().port);
});

// region PUSHER

function channelBinds(channel) {
	channel.bind("ready", (data) => {
		let part = SecretToParticipant.get(data.secret);
		part.ready = true;
		pusherS.trigger(channel.name, "runner-ready-changed", {
			runner: part.name,
			ready: true
		});
		let allReady = true;
		let theRace = races.find(r => r.name === channel.name);
		theRace.participants.some(p => {
			if(!p.ready) {
				allReady = false;
				return true;
			}
		});
		if(allReady) startRace(theRace);
	});
	channel.bind("unready", (data) => {
		let part = SecretToParticipant.get(data.secret);
		part.ready = false;
		pusherS.trigger(channel.name, "runner-ready-changed", {
			runner: part.name,
			ready: false
		});
	});
}

function bindSecret(channel) {
	channel.bind("gameInfo", (data) => {
		if(!(data.secret && data.level && data.x && data.y && data.z && data.igt && data.progress !== undefined)) { // Malformed message
			/*
			let missing = [];
			if(!data.secret) missing.push("secret");
			if(!data.level) missing.push("level");
			if(!data.x) missing.push("x");
			if(!data.y) missing.push("y");
			if(!data.z) missing.push("z");
			if(!data.igt) missing.push("igt");
			if(!data.progress) missing.push("progress");
			console.log("Missing game infos : " + missing);
			 */
			return;
		}
		ParticipantToGameInfos.set(SecretToParticipant.get(data.secret), {
			level: data.level,
			x: data.x,
			y: data.y,
			z: data.z,
			igt: data.igt,
			progress: data.progress
		});
	});
	channel.bind("finish", (data) => {
		if(!data.secret || !data.racename || !data.igt) return; // Malformed message
		let part = SecretToParticipant.get(data.secret);
		ParticipantToGameInfos.get(part).progress = 100;
		let theRace = races.find(r => r.name === data.racename);
		if(theRace === null) return;
		pusherS.trigger(theRace.name, "runner-finish", {
			runner: part.name,
			igt: data.igt
		})
		theRace.podium.push({
			name: part.name,
			igt: data.igt
		});
	});
}

// endregion

function getRaceInfos(race) {
	let gameInfos = [];
	race.participants.forEach(part => {
		if(!ParticipantToGameInfos.has(part)) return;
		let infos = ParticipantToGameInfos.get(part);
		gameInfos.push({
			name: part.name,
			progress: infos.progress,
			igt: infos.igt
		});
	});
	return gameInfos;
}

function startRace(race) {
	race.started = true;
	pusherS.trigger(race.name, "start", {
		countdown: COUNTDOWN
	});
	setTimeout(() => {
		race.startTime = new Date();
	}, COUNTDOWN * 1000);
}

const levelProgress = {
	'level01_cells': 0,
	'level02_vents': 4.82,
	'level03_messhall_entrance': 7.68,
	'level04_messhall': 8.72,
	'level05_sewers': 9.15,
	'level06_dr_swansons_room': 11.07,
	'level07_residental_corridors': [12.05, 21.59, 30.35], // Barrel road, After inf --> Larry, Larry --> Library
	'level10_machine_room': 23.88,
	'level11_infirmary': 19.02, // We enter infirmary before machine room
	'level13_library': 33.21,
	'level14_cave': 34.19,
	'level15_outside': 36.83,
	'level16_infected_corridors': [41.64, 52.04, 61.69], // Archangel, After lab --> Exam Room, Custscene 1 begin
	'level19_chemical_laboratory': 43.89,
	'level20_examination_room': 53.39,
	'level21_tower_1': [68.29, 83.21, 87.7, 92.13], // Enter tower cutscene 1, After trial 1, After trial 2, After trial 3
	'level21_tower_2': 82.47,
	'level21_tower_3': 86.31,
	'level21_tower_4': 90.9,
	'level22_ending': 96.58
}


function getRunProgress(level, x, y, z, passage = null) {
	let levelTime = levelProgress[level];
	if(typeof levelProgress.level === 'object' && passage !== null) levelTime = levelTime[passage];
	return levelTime + getLevelProgress[level](level, x, y ,z, passage);
}

class Race {
	constructor(name) {
		this.name = name;
		this.participants = [];
		this.startTime = null;
		this.podium = [];
		this.started = false;
	}
	addParticipant(p) {
		this.participants.push(p);
	}
}

class Participant {
	constructor(name, twitch) {
		this.name = name;
		this.twitch = twitch;
		this.ready = false;
	}
}

class MissingParameterError {
	constructor(missing) {
		this.error = "Your request has one or some missing parameters";
		this.missing = missing;
	}
}