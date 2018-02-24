/**
 * Module dependencies.
 */
var express = require( 'express' )
	, mailer = require( 'express-mailer' )
	, io = require( 'socket.io' )
	, http = require( 'http' )
	, twitter = require( 'twitter' )
	, _ = require( 'underscore' )
	, path = require( 'path' )
	, util = require( 'util' )
	, mongo = require( 'mongodb' ).MongoClient
	, ObjectID = require( 'mongodb' ).ObjectID
	, jwt = require( 'jwt-simple' )
	, geoip = require( "geoip-lite" )
	, Slack = require( "node-slack" )
	, portfolioList = [];


/**
 * ---------------
 * ----- APP -----
 * ---------------
 * */
//Create an express app!
var app = express();

//Create the HTTP server with the express app as an argument
var server = http.createServer( app );

//Generic Express setup
app.set( 'port', process.env.PORT || 8080 );
app.set( 'views', __dirname + '/views' );
app.set( 'view engine', 'html' );
app.set( 'layout', 'layout' );
app.set( 'partials', {
	header: 'includes/header',
	banner: 'pages/banner',
	me: 'pages/me',
	profile: 'pages/profile',
	skills: 'pages/skills',
	workeducation: 'pages/workeducation',
	portfolio: 'pages/portfolio',
	twitterwall: 'pages/twitterwall',
	contact: 'pages/contact',
	footer: 'includes/footer'
} );
//app.enable('view cache');
app.engine( 'html', require( 'hogan-express' ) );
app.use( express.compress() );
app.use( express.logger( 'dev' ) );
app.use( express.bodyParser() );
app.use( express.methodOverride() );
app.use( app.router );
app.use( require( 'stylus' ).middleware( __dirname + '/public' ) );
app.use( express.static( path.join( __dirname, 'public' ), { maxAge: 86400000 } ) );

//We're using bower components so add it to the path to make things easier
app.use( '/components', express.static( path.join( __dirname, 'components' ) ) );

/**
 * --------------------
 * ----- MONGO DB -----
 * --------------------
 * */

var mongoUrl = process.env.MONGODB_URI;

var enviromnent = app.get( 'env' );
var production = (enviromnent !== 'development');

// development only
if ( enviromnent === 'development' ) {
	app.use( express.errorHandler() );
	mongoUrl = 'mongodb://localhost:27017/gcardoso';
	require( "./gcardoso/env-variables" )();
}


/**
 * -----------------------------
 * ----- SLACK INTEGRATION -----
 * -----------------------------
 * */

var slack = new Slack( 'gcardoso', process.env.GCARDOSO_INWEBOOK_TOKEN );


/**
 * ------------------------
 * ----- TWITTER WALL -----
 * ------------------------
 * */
// Twitter symbols array
var watchSymbols = [ '#gcardoso', '@goncalocardo_o', '#angularjs', '#nodejs', '#javascript', '#mongodb', '#html', '#css', '#frontend' ];
//var watchSymbols = ['#gcardoso','@goncalocardo_o'];
//This structure will keep the total number of tweets received and a map of all the symbols and how many tweets received of that symbol
var watchList = {
	total: 0,
	symbols: {}
};
//Set the watch symbols to zero.
_.each( watchSymbols, function ( v ) {
	watchList.symbols[ v ] = 0;
} );

var t = new twitter( {
	consumer_key: process.env.TWITTER_CONSUMER_KEY,
	consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
	access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
	access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
} );

var arr = [];

function processTweetData( tweets ) {
	var newArr = [];

	for ( var i = 0; i < tweets.length; i++ ) {
		var data = tweets[ i ];

		if ( data.user.screen_name === "seedupio" ) continue;

		newArr.push( {
			name: data.user.name,
			username: '@' + data.user.screen_name,
			image: data.user.profile_image_url.replace( "_normal", "_bigger" ),
			text: data.text,
			imageVisible: true,
			created_at: new Date( data.created_at ).getTime(),
			date: data.created_at,
			tweeturl: 'http://www.twitter.com/' + data.user.screen_name + '/status/' + data.id_str
		} );
	}

	return newArr;
}


//Tell the twitter API to filter on the watchSymbols
t.stream( 'statuses/filter', { track: watchSymbols }, function ( stream ) {
	//We have a connection. Now watch the 'data' event for incomming tweets.
	stream.on( 'data', function ( data ) {
		//Make sure it was a valid tweet
		if ( data.text !== undefined ) {
			sockets.sockets.emit( 'data', processTweetData( [ data ] ) );
		}
	} );

	stream.on( 'error', function ( error ) {
		slack.send( {
			text: "@gcardoso Erro na conexão do Twitter. Erro: " + error,
			channel: '#gcardoso-portfolio',
			username: 'Portfolio',
			link_names: 1
		} );
	} );
} );

//Start a Socket.IO listen
var sockets = io.listen( server );
sockets.configure( function () {
	sockets.set( 'transports', [ 'xhr-polling' ] );
	//sockets.set('polling duration', 3600);
} );

sockets.on( 'disconnect', function () {
	slack.send( {
		text: "@gcardoso Os sockets estão em baixo. Reconnectar pff",
		channel: '#gcardoso-portfolio',
		username: 'Portfolio',
		link_names: 1
	} );
} );


/**
 * -----------------------------
 * ----- EMAIL INTEGRATION -----
 * -----------------------------
 * */

mailer.extend( app, {
	from: 'portfolio@gcardoso.pt',
	host: 'smtp.gcardoso.pt', // hostname
	secureConnection: false, // use SSL
	port: 25, // port for secure SMTP
	transportMethod: 'SMTP', // default is SMTP. Accepts anything that nodemailer accepts
	auth: {
		user: 'portfolio@gcardoso.pt',
		pass: process.env.GCARDOSO_EMAIL_PASSWORD
	}
} );


/**
 * --------------------
 * ----- ROUTES -------
 * --------------------
 * */

function extractDomain( url ) {
	var domain;
	//find & remove protocol (http, ftp, etc.) and get domain
	if ( url.indexOf( "://" ) > -1 ) {
		domain = url.split( '/' )[ 2 ];
	}
	else {
		domain = url.split( '/' )[ 0 ];
	}

	//find & remove port number
	domain = domain.split( ':' )[ 0 ];

	if ( domain.indexOf( 'www.' ) === 0 ) {
		domain = domain.replace( 'www.', '' );
	}

	return domain;
}

var isOffline = false;

/*-- Redirect --*/

if ( production ) {
	app.get( '/*', function ( req, res, next ) {
		if ( req.headers.host.match( /^www/ ) === null && req.headers.host.match( /herokuapp/ ) === null ) {
			res.redirect( 301, req.protocol + '://www.' + req.headers.host );
		}
		else {
			next();
		}
	} );
}

function getPortfolioAndRender( db, token, ip, res, years ) {
	var collection = db.collection( 'portfolio' );
	collection.find( {} ).toArray( function ( err, docs ) {
		portfolioList = docs.reverse();
		res.render( 'homepage', {
			age: years,
			portfolio: portfolioList,
			portfolioString: JSON.stringify( portfolioList ),
			token: token,
			country: (ip !== null ) ? ip.country : "No country",
			production: production
		} );
		db.close();
	} );
}


var birthDate = new Date( '1989-08-07' ),
	birthMonth = birthDate.getMonth(),
	birthDay = birthDate.getDate();

function getAge( today ) {
	var age = today.getFullYear() - birthDate.getFullYear(),
		currentMonth = today.getMonth(),
		currentDay = today.getDate();

	if ( ( currentMonth < birthMonth ) || ( currentMonth === birthMonth && currentDay < birthDay ) ) age--;

	return age;
}

//Our only route! Render it with the current watchList
app.get( '/', function ( req, res ) {
	var years = getAge( new Date() );

	if ( isOffline ) {
		res.status( 500 );
		res.render( 'error.html', { error: "500", layout: null, production: production } );
		res.end();
		return true;
	}

	var token = jwt.encode( {
		ip: req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress
	}, process.env.GCARDOSO_EMAIL_PASSWORD );

	var ip = geoip.lookup( req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress );

	mongo.connect( mongoUrl, null, function ( err, db ) {
		if ( err !== null ) {
			if ( enviromnent !== 'development' ) {
				slack.send( {
					text: "@gcardoso Erro no acesso à BD - " + err,
					channel: '#gcardoso-portfolio',
					username: 'Portfolio',
					link_names: 1
				} );
			}
			res.render( 'homepage', {
				age: years,
				portfolio: [],
				portfolioString: JSON.stringify( [] ),
				token: token,
				country: (ip !== null ) ? ip.country : "No country",
				production: production
			} );
			return false;
		}

		if ( enviromnent !== 'development' ) {
			slack.send( {
				text: "*New Access*\n" +
				( req.headers[ 'host' ] ? ( "Host: " + req.headers[ 'host' ] + '\n' ) : '' ) +
				( req.headers[ 'referer' ] ? ( "Referer: " + req.headers[ 'referer' ] + "\n" ) : "" ) +
				( ( ip !== null ) ? ( "Location info: " + JSON.stringify( ip ) ) + "\n" : "" ) +
				( ( ip && ip.country && ip.country !== "" ) ? ( "Country: :flag-" + ( ip.country ).toLowerCase() ) + ":" : "" ),
				channel: '#gcardoso-portfolio',
				username: 'Portfolio',
				link_names: 1
			} );
		}

		if ( req.headers[ 'referer' ] ) {
			var domain = extractDomain( req.headers[ 'referer' ] );
			var domainCollection = db.collection( 'domain' );
			domainCollection.find( { 'name': domain } ).toArray( function ( err, docs ) {

				if ( !err ) {
					if ( docs.length > 0 && docs[ 0 ][ 'allow' ] ) {
						getPortfolioAndRender( db, token, ip, res, years );

					} else if ( docs.length === 0 ) {
						var allow = (domain.indexOf( 'google' ) !== -1);

						domainCollection.insert( {
							'name': domain,
							'allow': allow
						}, function ( err, inserted, err2 ) {

							getPortfolioAndRender( db, token, ip, res, years );

							slack.send( {
								text: "@gcardoso NEW DOMAIN ADDED\n- " + domain + "\n- To allow send 'allow " + inserted[ 0 ]._id + "'\n- Default allow value: " + allow,
								channel: '#gcardoso-portfolio',
								username: 'Portfolio',
								link_names: 1
							} );

						} );
					} else {
						res.status( 500 ).end();
					}
				}
			} );
		} else {
			getPortfolioAndRender( db, token, ip, res, years );
		}
	} );
} );

app.post( '/getFirstTweets', function ( req, res ) {
	var token = jwt.encode( {
		ip: req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress
	}, process.env.GCARDOSO_EMAIL_PASSWORD );

	if ( req.body.token === token ) {
		t.search( '#gcardoso', function ( data ) {
			var newData = _.sortBy( data.statuses, function ( o ) {
				return new Date( o.created_at )
			} );
			res.json( { success: true, tweets: processTweetData( newData ) } );
		} );
	}

	else {
		res.status( 403 ).end();
	}
} );

app.post( '/sendEmail', function ( req, res ) {
	var token = jwt.encode( {
		ip: req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress
	}, process.env.GCARDOSO_EMAIL_PASSWORD );

	if ( req.body.token === token ) {
		slack.send( {
			text: "@gcardoso " + req.body.name + " (" + req.body.email + ") enviou email com o seguinte texto: " + req.body.message,
			channel: '#gcardoso-portfolio',
			username: 'Portfolio',
			link_names: 1
		} );

		app.mailer.send( 'emails/email', {
			from: 'gcardoso',
			to: 'goncalo.cb.ferreira@gmail.com', // REQUIRED. This can be a comma delimited string just like a normal email to field.
			subject: 'Portfolio', // REQUIRED.
			emailobject: req.body, // All additional properties are also passed to the template as local variables.
			layout: null
		}, function ( err ) {
			if ( err ) {
				res.status( 403 ).end();
				return;
			}
			res.json( 200, { success: true } );
		} );
	} else {
		res.status( 403 ).end();
	}
} );

function allowDomain( id, res ) {
	var o_id = new ObjectID( id );
	mongo.connect( mongoUrl, null, function ( err, db ) {
		if ( err !== null ) {
			if ( enviromnent !== 'development' ) {
				slack.send( {
					text: "@gcardoso Erro no acesso à BD - " + err,
					channel: '#gcardoso-portfolio',
					username: 'Portfolio',
					link_names: 1
				} );
			}
		} else {
			var domainCollection = db.collection( 'domain' );
			domainCollection.update( { _id: o_id }, { $set: { allow: true } }, function ( err ) {
				if ( !err ) {
					slack.send( {
						text: "Dominio atualizado com sucesso!",
						channel: '#gcardoso-portfolio',
						username: 'Portfolio'
					} );
				}
				res.status( 200 ).end();
			} );
		}
	} );
}

app.post( '/outwebook', function ( req, res ) {
	if ( req.body.token === process.env.GCARDOSO_OUTWEBOOK_TOKEN ) {
		var text = req.body.text.toLocaleLowerCase();

		switch ( req.body.trigger_word.toLocaleLowerCase() ) {
			case 'socket':
				switch ( text ) {
					case 'socket reconnect':
						sockets.socket.connect();
						break;

					case 'socket disconnect':
						sockets.socket.disconnect();
						break;
				}
				res.status( 200 ).end();
				break;
			case 'offline':
				switch ( text ) {
					case 'offline yes':
						isOffline = true;
						break;

					case 'offline no':
						isOffline = false;
						break;

					default:
						isOffline = true;
						break;
				}
				res.status( 200 ).end();
				break;
			case 'allow':
				var _id = text.replace( 'allow ', '' );
				allowDomain( _id, res );
				break;
		}
	} else {
		res.status( 403 ).end();
	}
} );

// Handle 404
app.use( function ( req, res ) {
	res.render( 'error.html', { error: "404", layout: null, production: production } );
} );

// Handle 500
app.use( function ( error, req, res, next ) {
	res.render( 'error.html', { error: "500", layout: null, production: production } );
} );

//Create the server
server.listen( app.get( 'port' ), function () {
	console.log( 'Express server listening on port ' + app.get( 'port' ) );
} );