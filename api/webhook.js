const https = require('https');
const crypto = require('crypto');

function recruitee_request(method, url, data) {
	return new Promise((resolve, reject) => {
		let options = {
			method: method,
			hostname: 'api.recruitee.com',
			path: '/c/' + process.env.RECRUITEE_COMPANY_ID + '/' + url,
			headers: {
				'Authorization': 'Bearer ' + process.env.RECRUITEE_API_KEY
			}
		};
		if(method === 'POST') {
			options.headers['Content-Type']='application/json';
			//weird quirks, somehow doesn't work without it
			options.headers['x-json-accent']='pascal';
		}
		const req = https.request(options, (res) => {
			if (res.statusCode != 200) {
				return reject(new Error('statusCode=' + res.statusCode));
			}
			var body = [];
			res.on('data', function(chunk) {
				body.push(chunk);
			});
			res.on('end', function() {
				try {
					body = JSON.parse(Buffer.concat(body).toString());
				} catch(e) {
					reject(e);
				}
				resolve(body);
			});
		});
		req.on('error', (e) => {
			reject(e.message);
		});
		// send the request
		if(method === 'POST') {
			req.write(JSON.stringify(data));
		}
		req.end();
	});
}
function recruitee_get(url) {
	return recruitee_request('GET',url);
}
function recruitee_post(url,data) {
	return recruitee_request('POST',url,data);
}
function vercel_getRawBody(req) {
    return new Promise((resolve, reject) => {
        let bodyChunks = [];
        req.on('end', () => {
            const rawBody = Buffer.concat(bodyChunks).toString('utf8');
            resolve(rawBody);
        });
        req.on('data', chunk => bodyChunks.push(chunk));
    });
}

module.exports = async (req, res) => {
	// turn off vercel edge-caching
	res.setHeader('Cache-Control', 'no-cache');

	//check if env variables are set
	if(!('RECRUITEE_API_KEY' in process.env)) {
		return res.status(500).send('missing env variable: RECRUITEE_API_KEY');
	}
	if(!('RECRUITEE_WEBHOOK_SECRET' in process.env)) {
		return res.status(500).send('missing env variable: RECRUITEE_WEBHOOK_SECRET');
	}
	if(!('RECRUITEE_COMPANY_ID' in process.env)) {
		return res.status(500).send('missing env variable: RECRUITEE_COMPANY_ID');
	}
	if(!('RECRUITEE_COMPANY_DOMAIN' in process.env)) {
		return res.status(500).send('missing env variable: RECRUITEE_COMPANY_DOMAIN');
	}

	//only POST requests are allowed
	if(req.method != 'POST') return res.status(405).send('');

	//decode query string
	if(!('pipeline' in req.query) || req.query.pipeline === '') {
		return res.status(400).send('missing query parameter: pipeline');
	}
	if(!('template' in req.query) || req.query.template === '') {
		return res.status(400).send('missing query parameter: template');
	}
	if(!('schedules' in req.query) || req.query.schedules == '') {
		return res.status(400).send('missing query parameter: schedules');
	}

	//ensure req body is json & get raw body
	if(req.body === undefined || req.body === "" || Object.keys(req.body).length === 0) {
		return res.status(400).send('invalid json payload');
	}
	req['raw_body'] = await vercel_getRawBody(req);

	//recruitee webhook test
	//has to be performed before signature check!
	if('test' in req.body) {
		return res.status(200).send('test successful');
	}

	//check hmac signature to verify its recruitee
	if(!('x-recruitee-signature' in req.headers) || req.headers['x-recruitee-signature'] == '') {
		return res.status(400).send('missing header: X-Recruitee-Signature');
	}
	let hmac = crypto.createHmac('sha256', process.env.RECRUITEE_WEBHOOK_SECRET);
	hmac.update(req.raw_body);
	let digest = hmac.digest('hex');
	//console.log("digest",digest);
	if(digest != req.headers['x-recruitee-signature']) {
		return res.status(400).send('X-Recruitee-Signature hmac signature is invalid');
	}

	//check if candidate was moved to correct pipeline
	if(!req.event_subtype === 'stage_changed') {
		return res.status(400).send('wrong event type: not a pipeline change');
	}
	if(req.body.event_type != 'candidate_moved') {
		return res.status(200).send('no action taken (candidate was qualified/disqualified)');
	}
	if(req.body.payload.details.to_stage.name != req.query.pipeline) {
		return res.status(200).send('no action taken (candidate was moved to pipeline '+req.body.payload.details.to_stage.name+', not '+req.query.pipeline+')');
	}

	//communicate with recruitee api
	try {
		//fetch schedules and filter all the ones starting with provided string (query.schedules)
		let rc_schedules = await recruitee_get("interview/schedules/available");
		rc_schedules_round_robin = rc_schedules.interview_schedules.filter(s => {
			return s.name.startsWith(req.query.schedules+"-");
		});
		if (rc_schedules_round_robin.length == 0) {
			return res.status(500).send('server error: recruitee - couldn\'t find matching schedules');
		}

		//select random schedule
		let rc_random_schedule = rc_schedules_round_robin[Math.floor(Math.random()*rc_schedules_round_robin.length)];

		//generate schedule link
		let rc_random_schedule_url = 'https://' + process.env.RECRUITEE_COMPANY_DOMAIN + '/v/i/s/' + rc_random_schedule.token + '/no-token'; //no-token gets automatically replaced by recruitee with a valid link

		//fetch email templates all find the one provided (query.template)
		let rc_email_templates = await recruitee_get("email_templates");
		let rc_email_templates_match = rc_email_templates.email_templates.filter(t => {
			return t.title === req.query.template;
		});
		if (rc_email_templates_match.length == 0) {
			return res.status(500).send('server error: recruitee - couldn\'t find matching email template');
		} else if (rc_email_templates_match.length > 1) {
			return res.status(500).send('server error: recruitee - found more than one matching email template');
		}
		let rc_email_template=rc_email_templates_match[0];

		//replace [[ROUNDROBIN]] in email template with schedule link
		if(!rc_email_template.body_html.includes('[[ROUNDROBIN]]')) {
			return res.status(500).send('server error: recruitee - email template \''+req.query.template+'\' does not contain [[ROUNDROBIN]] placeholder');
		}
		rc_email_template.body_html = rc_email_template.body_html.replace('[[ROUNDROBIN]]','<a target="_blank" href="'+rc_random_schedule_url+'" target="self">'+rc_random_schedule_url+'</a>');

		//send email
		let rc_email_data = {
			to:
				[
					{
						candidateId: req.body.payload.candidate.id,
						candidateEmail: req.body.payload.candidate.emails[0]
					}
				],
			cc: [],
			bcc: [],
			subject: rc_email_template.subject,
			bodyHtml: rc_email_template.body_html,
			replyToMessageId: null,
			attachments: [],
			admins: [],
			visibility: {
				roleIds: [],
				level: 'public',
				adminIds: []
			},
			sendAt: null,
			sendAtTimezone: null,
			adminIds: []
		};
		//console.log("email-data", rc_email_data);
		let rc_email_send = await recruitee_post('mailbox/send',rc_email_data);
		//console.log("email send", rc_email_send);
		
		return res.status(200).send('email successfully sent!\n'+JSON.stringify(rc_email_send));
	} catch(err) {
		return res.status(500).send('server error: error communicating with recruitee api: '+err);
	}
	res.status(200).send('success');
  }