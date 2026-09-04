'use strict';

const LIB_CRYPTO = require( 'crypto' );

const jsongin = require( '@liquicode/jsongin' );
const MSSQL = require( 'mssql' );


// ***How long a pooled connection may sit idle before the pool reaps it.***
//
// This is the only thing standing between a held pool and a process which will not exit, so it
// is a correctness value rather than a tuning one. node-mssql's own default is 30 seconds,
// which leaves a finished test run apparently hung for half a minute. A second is long enough
// that a conformance row never reconnects, and short enough that nobody waits on it.
const POOL_IDLE_TIMEOUT_MS = 1000;


module.exports = {

	AdapterName: 'jsonstor-mssql',
	AdapterDescription: 'Documents are stored in a Microsoft SQL Server database.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { Settings.Server = 'localhost'; }
		if ( jsongin.ShortType( Settings.Port ) !== 'n' ) { Settings.Port = 1433; }
		if ( jsongin.ShortType( Settings.Database ) !== 's' ) { throw new Error( `This adapter requires a Settings.Database string parameter.` ); }
		if ( jsongin.ShortType( Settings.Table ) !== 's' ) { throw new Error( `This adapter requires a Settings.Table string parameter.` ); }
		if ( jsongin.ShortType( Settings.UserName ) !== 's' ) { throw new Error( `This adapter requires a Settings.UserName string parameter.` ); }
		if ( jsongin.ShortType( Settings.Password ) !== 's' ) { throw new Error( `This adapter requires a Settings.Password string parameter.` ); }
		// ***MS Sql Server has schemas, and `dbo` is where an unqualified CREATE TABLE puts a
		// table.*** Every statement here names the schema, so a catalog read cannot match a
		// same-named table in another schema and answer with whichever came back first.
		if ( jsongin.ShortType( Settings.Schema ) !== 's' ) { Settings.Schema = 'dbo'; }
		// ***The identity settings.*** PrimaryKey is the current spelling and IdField is the
		// deprecated one; Resolve reads either and prefers the current. jsonstor-mysql and
		// jsonstor-postgres are published declaring IdField, so unlike the TLS rename this one
		// reaches released packages and the old spelling goes on working.
		// See jsonx/.plans/primary-keys-and-indexes.md.
		let key_declaration = jsonstor.PrimaryKey.Resolve( Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			// ***Declared, not built.*** Every by-key statement here locates a row by a single
			// value - id_to_key() answers one and select_by_id() takes one - so an adapter which
			// cannot honor a composite key refuses it by name rather than keying on the first.
			throw new Error( `This adapter does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		// ***Empty still means discover it from the catalog***, which is what a foreign table
		// needs and is the behavior IdField has always had.
		Settings.IdField = key_declaration.Fields.length ? key_declaration.Fields[ 0 ] : '';
		if ( jsongin.ShortType( Settings.PrimaryKeyMutable ) !== 'b' ) { Settings.PrimaryKeyMutable = false; }
		if ( jsongin.ShortType( Settings.ModifySchema ) !== 'b' ) { Settings.ModifySchema = false; }
		// ***An unencrypted connection is not the default in this driver.*** node-mssql defaults
		// `encrypt` to true, which a container with a self-signed certificate refuses. Both are
		// settings rather than assumptions, so a caller reaching a real server can turn them on.
		if ( jsongin.ShortType( Settings.Encrypt ) !== 'b' ) { Settings.Encrypt = false; }
		if ( jsongin.ShortType( Settings.TrustServerCertificate ) !== 'b' ) { Settings.TrustServerCertificate = true; }
		// The storage model. See jsonx/.plans/sql-adapter-architecture.md - real columns are an
		// index which pre-filters, and the payload column carries the document. With no payload
		// column the table *is* the document, and a field with no column is refused by name.
		if ( jsongin.ShortType( Settings.PayloadColumn ) !== 's' ) { Settings.PayloadColumn = ''; }
		if ( jsongin.ShortType( Settings.PayloadSync ) !== 'b' ) { Settings.PayloadSync = false; }
		if ( jsongin.ShortType( Settings.Columns ) !== 'a' ) { Settings.Columns = []; }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		Storage.Catalog = {
			initialized: false,
			fields: null,
			id_field: null,
		};


		//=====================================================================
		// The primary key column this adapter creates when it creates a table.
		//
		// ***A length is not optional here, and 450 is not an arbitrary number.*** An index key
		// in SQL Server is limited to 900 bytes and an NVARCHAR character costs two, so 450 is
		// the longest string which can carry a PRIMARY KEY. NVARCHAR(MAX) cannot be indexed at
		// all. This is comfortably above a uuid.
		const DEFAULT_ID_FIELD = '_id';
		const DEFAULT_ID_TYPE = 'NVARCHAR(450) NOT NULL';

		// ***NVARCHAR(MAX) rather than a JSON type, for the family's usual reason.*** A parsed
		// form hands back its own key order, so a strict equality against a whole object would
		// compare a document nobody wrote. SQL Server has no JSON column type before 2025 in any
		// case; `json` there would raise the same question and get the same answer.
		const PAYLOAD_TYPE = 'NVARCHAR(MAX) NULL';

		// The type a declared column gets when the caller names one without a type.
		const DEFAULT_COLUMN_TYPE = 'NVARCHAR(MAX) NULL';

		// ***Insertion order needs a column here, the way it does in MySQL and Postgres.***
		//
		// A) CRUD Tests asserts that a collection reads back in the order it was written, and a
		// SELECT with no ORDER BY promises nothing. SQL Server has no hidden row identifier which
		// survives an update - %%physloc%% is a physical address and moves - so an IDENTITY
		// column is the honest answer and it is Postgres's `_seq` under this engine's spelling.
		//
		// It is never a document field. It is excluded from every row read, every row written,
		// and from the pre-filter. A foreign table has none and is read in the server's order.
		const SEQ_FIELD = '_seq';
		const SEQ_TYPE = 'BIGINT IDENTITY(1,1)';


		//=====================================================================
		// ***What MS Sql Server does differently, declared in one place.***
		//
		// SqlExpression defaults every one of these to the answer which is safe on every
		// engine, so this list is exactly what this engine asks for beyond that. See
		// jsonx/.plans/sql-adapter-architecture.md, The Dialect Interface.
		//
		// ***Measured against 16.0.4265.3 on 2026-09-01 before any of this was written***, which
		// is the family's rule: a dialect is a measurement rather than a recollection.
		//
		// ***No new translator option was needed***, which is what the adapter roadmap predicted
		// for this engine and for Oracle. What came out is ***Oracle's dialect exactly***, which
		// was not the prediction: the two engines are unrelated and arrive at the same seven
		// answers, because both lack a boolean expression type and both are strict about types.
		const SQL_DIALECT = {
			// ***Standard double quotes, not the brackets everyone writes.*** SQL Server accepts
			// both, and `SqlExpression` applies one string on both sides of an identifier - so
			// `[` and `]` are not expressible by it at all. QUOTED_IDENTIFIER is ON by default
			// on this driver's connections, verified with SESSIONPROPERTY, so the standard
			// spelling works and the shared translator needed no change to say it.
			IdentifierQuotes: '"',
			StringLiteralQuotes: `'`,
			// A backslash is an ordinary character in a SQL Server string literal; the quote is
			// doubled instead, which is standard SQL. Verified: SELECT 'it''s'.
			StringLiteralEscape: 'double',
			// Verified against a live server: 'a%b' LIKE 'a!%b' ESCAPE '!' is true. There is no
			// default escape character, so a pattern which escapes a literal % has to name it.
			LikeEscapeCharacter: '\\',
			LikeEscapeClause: true,
			// ***No IS NOT TRUE.*** `(1 = 0) IS NOT TRUE` answers
			// `Incorrect syntax near the keyword 'IS'`.
			NegateWithIsNotTrue: false,
			// ***And the portable form does not run here either, for Oracle's reason.***
			// `((NOT ("n" >= 2)) OR ("n" >= 2) IS NULL)` answers the same syntax error, because
			// SQL Server has no boolean expression type: a comparison cannot appear where a
			// value is wanted. `SELECT (1 = 1)` is itself a syntax error. A CASE takes a
			// condition and can tell TRUE from FALSE and UNKNOWN, so it is the spelling here.
			NegateWithCaseExpression: true,
			// ***Left unrendered, and the reason is the translator rather than the engine.***
			//
			// This engine can express both - measured on a live server, `5 % 3` answers 2 and
			// `5 ^ 3`, `5 & 3`, `5 | 3` answer 6, 1 and 7 - so these were declared `true` at
			// first. ***They were wrong.*** `SqlExpression` renders `$mod` as
			// `MOD(TRUNCATE(x, 0), d)` and the `$bits*` operators with the same `TRUNCATE`
			// guard, and SQL Server has ***neither function***: it spells them `%` and
			// `ROUND(x, 0, 1)`. The statement came back with
			// `Incorrect syntax near the keyword 'TRUNCATE'`.
			//
			// ***So the shared rendering is MySQL-spelled and the option means "can you read
			// this rendering", not "can you do this arithmetic".*** Postgres and Oracle declare
			// these false for the same kind of reason, and per-dialect parity is deferred across
			// the whole family. Dropping them broadens, which costs time and never an answer.
			RendersModulo: false,
			RendersBitwise: false,
			// ***This engine throws where SQLite and MySQL coerce.*** An INT column compared
			// against 'not-a-number' answers `Conversion failed when converting the varchar
			// value 'not-a-number' to data type int`, and an aborted statement returns nothing
			// for jsongin to filter - so the caller would get an error instead of a broad
			// answer. Declaring this drops the predicate instead.
			RefusesTypeMismatch: true,
			// ***There is no BOOLEAN type and no boolean literal.*** `CAST(1 AS BOOLEAN)` answers
			// `Type BOOLEAN is not a defined system type` and `1 = TRUE` reads TRUE as a column
			// name. A boolean lives in a BIT here and compares against 1 and 0 - and a BIT reads
			// back as a JavaScript boolean, which is why short_type_of still answers 'b' for it.
			BooleanLiterals: 'number',
		};


		//=====================================================================
		// ***What an integer column will actually hold.***
		//
		// SQL Server refuses an out-of-range integer rather than storing it, so this is a
		// fidelity question in the same way it is for Postgres. See value_fits_column.
		const MAX_SAFE = 9007199254740991;
		const INTEGER_RANGES = {
			tinyint: { Low: 0, High: 255 },
			smallint: { Low: -32768, High: 32767 },
			int: { Low: -2147483648, High: 2147483647 },
			bigint: { Low: -MAX_SAFE, High: MAX_SAFE },
		};


		//=====================================================================
		// SQL Server names its types in INFORMATION_SCHEMA.COLUMNS.DATA_TYPE, lower cased and
		// without the length - so these are exact and there is no affinity to guess at.
		function short_type_of( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			// ***BIT is this engine's boolean and the driver reads it back as one***, so the
			// round trip is honest even though the clause compares against 1 and 0.
			if ( type === 'bit' ) { return 'b'; }
			if ( type === 'tinyint' ) { return 'n'; }
			if ( type === 'smallint' ) { return 'n'; }
			if ( type === 'int' ) { return 'n'; }
			if ( type === 'bigint' ) { return 'n'; }
			if ( type === 'decimal' ) { return 'n'; }
			if ( type === 'numeric' ) { return 'n'; }
			if ( type === 'float' ) { return 'n'; }
			if ( type === 'real' ) { return 'n'; }
			if ( type === 'money' ) { return 'n'; }
			if ( type === 'smallmoney' ) { return 'n'; }
			if ( type === 'nvarchar' ) { return 's'; }
			if ( type === 'varchar' ) { return 's'; }
			if ( type === 'nchar' ) { return 's'; }
			if ( type === 'char' ) { return 's'; }
			// Everything else - text, ntext, varbinary, datetime, uniqueidentifier, xml, a user
			// type. Deliberately outside the 'bns' set SQL_Query pre-filters on: nothing here
			// knows how this engine compares those, and a clause it cannot reason about could
			// narrow. The payload column is NVARCHAR(MAX) and is never pre-filtered on anyway.
			return '?';
		}


		//=====================================================================
		// Whether this column holds whole numbers only.
		function is_integer_type( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			return ( type === 'tinyint' ) || ( type === 'smallint' ) || ( type === 'int' ) || ( type === 'bigint' );
		}


		//=====================================================================
		// An identifier, quoted the way SQL Server quotes one under QUOTED_IDENTIFIER.
		// Doubles an embedded double quote, which is the only escape available.
		function quote_identifier( Name )
		{
			if ( jsongin.ShortType( Name ) !== 's' ) { throw new Error( `An identifier must be a string.` ); }
			return '"' + Name.split( '"' ).join( '""' ) + '"';
		}


		//=====================================================================
		// A string literal, for the two places a name has to travel inside one. Only the schema
		// check needs this; every other name reaches a statement as an identifier.
		function quote_literal( Value )
		{
			return `'` + ( '' + Value ).split( `'` ).join( `''` ) + `'`;
		}


		//=====================================================================
		// The table, as the statements name it. Schema qualified, so a statement does not
		// depend on the connection's default schema.
		function table_reference()
		{
			return quote_identifier( Storage.Settings.Schema ) + '.' + quote_identifier( Storage.Settings.Table );
		}


		//=====================================================================
		// WithConnection
		//
		// ***One pool for the life of the storage, drained by its own idle timeout.***
		//
		// This used to open a pool per statement, on the grounds that the Storage interface has
		// no Close, so a held pool would keep sockets in the event loop and the process would
		// not exit. ***That was measured and it is not what happens.*** node-mssql's pool
		// already defaults to min 0, so it reaps its own idle connections and the process does
		// exit - it exits idleTimeoutMillis late, and that default is 30 seconds, which is what
		// read as a hang. Shortening the timeout is the whole fix: 30.4s becomes 1.1s.
		//
		// ***The cost of the old pattern was not marginal.*** Against the live server a
		// statement on a fresh pool is 34ms and a statement on a held pool is 3.8ms, because
		// every one paid for a TCP connect, a TLS negotiation and a login. One conformance row
		// of 134 tests went from 75.3s to 11.5s, which took MS Sql Server from the slowest
		// engine in the family to an ordinary one.
		//
		// ***A pool of its own rather than the driver's global one.*** mssql.connect() stores
		// one pool on the module, so two storages pointed at different servers in the same
		// process would silently share the first one's connection - which is exactly what a
		// conformance run does.
		//
		// ***Opened through a promise rather than a flag***, so two concurrent first calls
		// cannot each open a pool and leave the loser's unreachable. This is jsonstor-oracle's
		// held_connection shape, and like that one it ***forgets a failure***: a server which
		// did not answer is a transient condition, and remembering it would poison the storage
		// for its whole life.
		let connection_pool = null;
		async function WithConnection( Handler /* ( Pool ) */ )
		{
			if ( connection_pool === null )
			{
				let pool = new MSSQL.ConnectionPool( {
					server: Storage.Settings.Server,
					port: Storage.Settings.Port,
					database: Storage.Settings.Database,
					user: Storage.Settings.UserName,
					password: Storage.Settings.Password,
					options: {
						encrypt: Storage.Settings.Encrypt,
						trustServerCertificate: Storage.Settings.TrustServerCertificate,
					},
					pool: { min: 0, max: 10, idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS },
				} );
				connection_pool = pool.connect().catch(
					function ( ConnectError )
					{
						connection_pool = null;
						throw ConnectError;
					} );
			}
			return await Handler( await connection_pool );
		}


		//=====================================================================
		// ***The dialect is checked against the server once, on the first statement.***
		//
		// The connection is lazy and `GetStorage` is synchronous, so a mismatched server cannot
		// be caught at construction and surfaces on the first operation instead. ***The outcome
		// is remembered, so every later call fails the same way***: a storage pointed at a
		// server its dialect cannot serve is wrong for its whole life, not only once.
		//
		// ***A server which did not answer is not remembered***, because that is a transient
		// failure rather than an answer, and caching it would poison the storage.
		let dialect_check = null;
		async function ensure_dialect_checked()
		{
			if ( dialect_check !== null )
			{
				if ( dialect_check.Error ) { throw dialect_check.Error; }
				return;
			}
			// Set before asking, so that StorageInfo's own statement does not re-enter this.
			dialect_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { dialect_check.Error = error; }
				else { dialect_check = null; }
				throw error;
			}
			return;
		}


		//=====================================================================
		// SQL_Passthrough
		//
		// The one place a statement runs. Normalized to the { results, info } shape the sibling
		// adapters answer with, so that a caller reads the same way in all of them.
		//
		// ***A parameter is bound by name here***, which is the one place this driver differs
		// from every sibling. mysql2 and better-sqlite3 take a positional `?`, pg numbers them
		// `$1`, and all three take an array; node-mssql wants `request.input( 'p1', value )` and
		// then `@p1` in the statement. The array is still the interface, so the callers below
		// are unchanged - the naming happens here.
		async function SQL_Passthrough( SqlStatement, SqlParameters = [] )
		{
			await ensure_dialect_checked();
			return await WithConnection(
				async function ( Pool )
				{
					let request = Pool.request();
					for ( let index = 0; index < SqlParameters.length; index++ )
					{
						request.input( 'p' + ( index + 1 ), SqlParameters[ index ] );
					}
					let result = await request.query( SqlStatement );
					let affected = 0;
					if ( Array.isArray( result.rowsAffected ) && result.rowsAffected.length )
					{
						affected = result.rowsAffected[ 0 ];
					}
					return {
						results: result.recordset || [],
						info: { changes: affected },
					};
				} );
		}


		//=====================================================================
		// DDL, which takes no parameters and returns no rows.
		async function SQL_Execute( SqlStatement )
		{
			await SQL_Passthrough( SqlStatement, [] );
			return true;
		}


		//=====================================================================
		// A value on its way into a bound parameter.
		//
		// ***node-mssql binds a boolean and a number natively***, and it infers the type from
		// the value - so `undefined` is the one case which needs an answer, because an inferred
		// type for it is nothing at all.
		function value_to_parameter( Value )
		{
			if ( typeof Value === 'undefined' ) { return null; }
			return Value;
		}


		//=====================================================================
		// The @p1, @p2 tokens a SQL Server statement binds with.
		function parameter_token( Index )
		{
			return '@p' + Index;
		}


		//=====================================================================
		// ***The catalog is marked known only once it has been read.***
		//
		// This used to set `initialized` on the way in, which made a failed read
		// indistinguishable from an empty database: the flag stayed true, `table_exists` stayed
		// false, and every later call served that back as a fact. A Count against a server which
		// was not answering returned ***0*** rather than failing - the first call threw and every
		// one after it lied, which is the worst shape an error can take here. Setting the flag on
		// the way out is the whole fix: a read which throws leaves the catalog unknown, and the
		// next call asks again.
		//
		// ***Memoized while it is in flight***, because two concurrent first calls had a quieter
		// version of the same bug - the second saw the flag the first had just set and carried on
		// against a catalog which had not been filled in yet.
		let catalog_read = null;
		async function update_catalog()
		{
			if ( Storage.Catalog.initialized ) { return Storage.Catalog; }
			if ( catalog_read === null )
			{
				catalog_read = read_catalog().then(
					function ( Catalog )
					{
						Storage.Catalog.initialized = true;
						catalog_read = null;
						return Catalog;
					},
					function ( ReadError )
					{
						catalog_read = null;
						throw ReadError;
					} );
			}
			return await catalog_read;
		}

		async function read_catalog()
		{
			Storage.Catalog.table_exists = false;
			Storage.Catalog.fields = {};
			Storage.Catalog.id_field = Storage.Settings.IdField;
			Storage.Catalog.order_by = null;
			Storage.Catalog.payload_field = null;

			let table_rows = await SQL_Passthrough(
				`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE ((TABLE_SCHEMA = @p1) AND (TABLE_NAME = @p2))`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			if ( !table_rows.results.length ) { return Storage.Catalog; }
			Storage.Catalog.table_exists = true;

			// The primary key columns, by name. A composite key is read but only its first
			// column is ever treated as the identity, which is what the sibling adapters do.
			let key_rows = await SQL_Passthrough(
				`SELECT kcu.COLUMN_NAME
					FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
					JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
						ON ( ( kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME )
							AND ( kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA ) )
					WHERE ( ( tc.CONSTRAINT_TYPE = 'PRIMARY KEY' )
						AND ( tc.TABLE_SCHEMA = @p1 )
						AND ( tc.TABLE_NAME = @p2 ) )
					ORDER BY kcu.ORDINAL_POSITION`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			let primary_keys = {};
			for ( let index = 0; index < key_rows.results.length; index++ )
			{
				primary_keys[ key_rows.results[ index ].COLUMN_NAME ] = true;
			}

			// ***An identity column is not in INFORMATION_SCHEMA at all.*** Postgres answers
			// `is_identity` there and SQL Server does not, so this reads `sys.columns`, which is
			// the only place the engine records it.
			let identity_rows = await SQL_Passthrough(
				`SELECT c.name AS COLUMN_NAME
					FROM sys.columns c
					JOIN sys.tables t ON ( t.object_id = c.object_id )
					JOIN sys.schemas s ON ( s.schema_id = t.schema_id )
					WHERE ( ( s.name = @p1 ) AND ( t.name = @p2 ) AND ( c.is_identity = 1 ) )`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			let identities = {};
			for ( let index = 0; index < identity_rows.results.length; index++ )
			{
				identities[ identity_rows.results[ index ].COLUMN_NAME ] = true;
			}

			let columns = await SQL_Passthrough(
				`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE ( ( TABLE_SCHEMA = @p1 ) AND ( TABLE_NAME = @p2 ) )
					ORDER BY ORDINAL_POSITION`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			for ( let index = 0; index < columns.results.length; index++ )
			{
				let column = columns.results[ index ];
				let data_type = column.DATA_TYPE || '';
				// ***A MAX column reports its length as -1, which is not a length.*** Taken
				// literally it would make value_fits_column refuse every string, since no string
				// is shorter than -1 characters - so the payload column would reject the payload.
				let max_length = column.CHARACTER_MAXIMUM_LENGTH;
				if ( max_length === -1 ) { max_length = null; }
				let field = {
					name: column.COLUMN_NAME,
					type_name: data_type,
					short_type: short_type_of( data_type ),
					allow_null: ( column.IS_NULLABLE === 'YES' ),
					is_primary_key: !!primary_keys[ column.COLUMN_NAME ],
					is_identity: !!identities[ column.COLUMN_NAME ],
					is_auto_increment: !!identities[ column.COLUMN_NAME ],
					is_integer: is_integer_type( data_type ),
					max_length: max_length,
				};
				Storage.Catalog.fields[ column.COLUMN_NAME ] = field;
			}

			// A configured IdField wins, then _id by name, and only then a foreign table's
			// identity key. The _seq column is never the identity - it carries insertion order
			// and this adapter creates it alongside an NVARCHAR primary key.
			if ( !Storage.Catalog.id_field && Storage.Catalog.fields[ DEFAULT_ID_FIELD ] )
			{
				Storage.Catalog.id_field = DEFAULT_ID_FIELD;
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_auto_increment ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_primary_key ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}

			// Insertion order. See SEQ_FIELD - a table this adapter created has one, and a
			// foreign table is read in the server's order.
			if ( Storage.Catalog.fields[ SEQ_FIELD ] ) { Storage.Catalog.order_by = SEQ_FIELD; }

			// The payload column, if this storage was configured with one and the table has it.
			if ( Storage.Settings.PayloadColumn )
			{
				Storage.Catalog.payload_field =
					Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] || null;
			}

			return Storage.Catalog;
		}


		//=====================================================================
		// ensure_schema
		//
		// ***jsonstor never infers a column from a document.*** Columns come from the Columns
		// declaration when this adapter creates the table, or from the table as it was found.
		// Nothing else. See jsonx/.plans/sql-adapter-architecture.md, rule R2.
		//=====================================================================
		async function ensure_schema()
		{
			if ( !Storage.Catalog.initialized ) { await update_catalog(); }
			if ( !Storage.Settings.ModifySchema ) { return; }

			let changed = false;

			if ( !Storage.Catalog.table_exists )
			{
				// ***There is no CREATE SCHEMA IF NOT EXISTS here***, and no CREATE TABLE IF NOT
				// EXISTS either. `CREATE SCHEMA` must also be the first statement in its batch,
				// so it goes inside an EXEC - which is the documented spelling for exactly this.
				await SQL_Execute(
					`IF NOT EXISTS ( SELECT 1 FROM sys.schemas WHERE ( name = ${quote_literal( Storage.Settings.Schema )} ) )`
					+ ` EXEC(${quote_literal( 'CREATE SCHEMA ' + quote_identifier( Storage.Settings.Schema ) )})` );
				let id_column = declared_id_column();
				let sql = `CREATE TABLE ${table_reference()} (`
					+ ` ${quote_identifier( id_column.Name )} ${id_column.Type} PRIMARY KEY,`
					+ ` ${quote_identifier( SEQ_FIELD )} ${SEQ_TYPE} )`;
				await SQL_Execute( sql );
				Storage.Catalog.initialized = false;
				await update_catalog();
				changed = true;
			}

			// Every declared column which is not there yet, then the payload column. Declared
			// columns carry their SQL type verbatim: this is a SQL adapter, and a caller who
			// names a table also names its types.
			let additions = [];
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				if ( column.Key ) { continue; }
				if ( Storage.Catalog.fields[ column.Name ] ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_COLUMN_TYPE;
				additions.push( { Name: column.Name, Type: type } );
			}
			if ( Storage.Settings.PayloadColumn && !Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				additions.push( { Name: Storage.Settings.PayloadColumn, Type: PAYLOAD_TYPE } );
			}

			// ***One ALTER with a list, and no COLUMN keyword.*** SQL Server spells it
			// `ALTER TABLE t ADD a INT, b INT` where Postgres and MySQL want `ADD COLUMN` on
			// each clause. One statement rather than a loop means the table is never half
			// altered.
			if ( additions.length )
			{
				let clauses = [];
				for ( let index = 0; index < additions.length; index++ )
				{
					clauses.push( `${quote_identifier( additions[ index ].Name )} ${additions[ index ].Type}` );
				}
				await SQL_Execute( `ALTER TABLE ${table_reference()} ADD ${clauses.join( ', ' )}` );
				changed = true;
			}

			if ( changed )
			{
				Storage.Catalog.initialized = false;
				await update_catalog();
			}
			return;
		}


		//=====================================================================
		// The primary key column this adapter creates.
		function declared_id_column()
		{
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( !column.Key ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_ID_TYPE;
				return { Name: column.Name, Type: type };
			}
			let name = Storage.Settings.IdField || DEFAULT_ID_FIELD;
			return { Name: name, Type: DEFAULT_ID_TYPE };
		}


		//=====================================================================
		// Whether a column can hold this value without changing it.
		//
		// ***The question is the round trip, not whether the server will accept it.*** SQL
		// Server behaves like Postgres here rather than like MySQL: it ***rounds*** a fractional
		// value into an integer column and ***throws*** on an out of range integer or an over
		// length string.
		//
		// ***Rounding is the one which costs an answer.*** Under PayloadSync a column is a
		// projection of the payload and F4 broadens every predicate on it with IS NULL, so a
		// value the column could not hold is admitted by the NULL. A rounded value is not NULL.
		// It is a wrong number sitting where a right one should be, the clause compares against
		// it, and the row never travels - which is the narrowing the pre-filter invariant
		// forbids. So a fractional value does not fit an integer column, and it goes to the
		// payload with a NULL left behind to admit it.
		function value_fits_column( Field, Value )
		{
			let st = jsongin.ShortType( Value );
			if ( !'bns'.includes( st ) ) { return false; }
			if ( Field.short_type !== st ) { return false; }
			if ( st === 'n' )
			{
				if ( !Number.isFinite( Value ) ) { return false; }
				if ( Field.is_integer )
				{
					if ( !Number.isInteger( Value ) ) { return false; }
					let range = INTEGER_RANGES[ Field.type_name.toLowerCase() ];
					if ( range && ( ( Value < range.Low ) || ( Value > range.High ) ) ) { return false; }
				}
				else if ( ( Value > MAX_SAFE ) || ( Value < -MAX_SAFE ) ) { return false; }
			}
			if ( st === 's' )
			{
				if ( Number.isInteger( Field.max_length ) && ( Value.length > Field.max_length ) ) { return false; }
			}
			return true;
		}


		//=====================================================================
		function parse_payload( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return {}; }
			if ( typeof Value === 'string' )
			{
				if ( !Value ) { return {}; }
				return JSON.parse( Value );
			}
			return Value;
		}


		//=====================================================================
		function serialize_payload( Value )
		{
			return JSON.stringify( Value );
		}


		//=====================================================================
		// document_to_row
		//
		// Splits a document into the columns which pre-filter and the payload which stores it,
		// according to the three configurations in the architecture document.
		function document_to_row( Document )
		{
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );
			let row = {};

			if ( has_payload && Storage.Settings.PayloadSync )
			{
				// F3. The payload is the whole document and the columns are projections of it,
				// each holding the value when it fits and NULL when it does not. Reads never
				// take a value from a column, so a NULL here costs a pre-filter and not an
				// answer - SqlExpression broadens a projected column for exactly that reason.
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === payload_name ) { continue; }
					if ( key === SEQ_FIELD ) { continue; }
					let field = Storage.Catalog.fields[ key ];
					if ( field.is_auto_increment ) { continue; }
					if ( key === Storage.Catalog.id_field ) { continue; }
					let value = Document[ key ];
					row[ key ] = value_fits_column( field, value ) ? value : null;
				}
				row[ payload_name ] = serialize_payload( Document );
				return row;
			}

			let remainder = {};
			for ( let key in Document )
			{
				if ( key.includes( '.' ) ) { continue; }
				if ( key === payload_name )
				{
					throw new Error( `Cannot store a field named [${key}], it is this storage's payload column.` );
				}
				let value = Document[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( !field )
				{
					// F1. A field with no column is refused rather than dropped.
					if ( !has_payload )
					{
						throw new Error( `Cannot store the field [${key}], the table [${Storage.Settings.Table}] has no such column and this storage has no payload column.` );
					}
					remainder[ key ] = value;
					continue;
				}
				if ( key === SEQ_FIELD ) { continue; }
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Catalog.id_field ) { continue; }
				if ( jsongin.ShortType( value ) === 'l' ) { row[ key ] = null; continue; }
				if ( !value_fits_column( field, value ) )
				{
					// F2. The column is the only home this field has, so a value it cannot hold
					// is refused rather than coerced into a lie.
					throw new Error( `Cannot store the field [${key}], its value does not fit the column's type [${field.type_name}]. Configure a PayloadColumn to store values of any type.` );
				}
				row[ key ] = value;
			}
			if ( has_payload ) { row[ payload_name ] = serialize_payload( remainder ); }
			return row;
		}


		//=====================================================================
		function row_to_document( Row )
		{
			if ( !Row ) { return null; }
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );

			// F3. Under PayloadSync the payload is the document and the columns are projections
			// of it, so a value is never taken from a column. That is the whole reason this
			// configuration keeps absent apart from null and a number apart from its string:
			// the payload is real JSON and a column is not.
			if ( has_payload && Storage.Settings.PayloadSync )
			{
				return parse_payload( Row[ payload_name ] );
			}

			// The columns are the document here, so the round trip is only as good as they are.
			let document = {};
			for ( let key in Row )
			{
				if ( has_payload && ( key === payload_name ) ) { continue; }
				// Insertion order is storage bookkeeping and never a field of the document.
				if ( key === SEQ_FIELD ) { continue; }
				let value = Row[ key ];
				let field = Storage.Catalog.fields[ key ];
				// ***node-mssql hands back BIGINT as a string, the way pg does***, because it
				// can hold values a JavaScript number cannot represent and the driver refuses to
				// lose precision silently. A column declared to hold numbers has to read back as
				// a number here or the round trip reports a string where one was never stored.
				if ( field && ( field.short_type === 'n' ) && ( typeof value === 'string' ) )
				{
					value = Number( value );
				}
				document[ key ] = value;
			}
			document = jsongin.Unhybridize( document );
			if ( has_payload )
			{
				let remainder = parse_payload( Row[ payload_name ] );
				for ( let key in remainder ) { document[ key ] = remainder[ key ]; }
			}
			return document;
		}


		//=====================================================================
		// ***Options is threaded in rather than held in a closure.*** It carries the statistics
		// collector for this one call, and a variable on the Storage would blend two overlapping
		// calls into one meaningless pair of numbers.
		async function SQL_Query( Criteria, MaxDocs = 0, Options = null )
		{
			// A malformed criteria is refused, not answered - the same rule the built in
			// adapters apply. Without it a criteria of the wrong type reaches SqlExpression
			// and comes back as an empty clause, which reads as "match everything".
			let st_criteria = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( st_criteria ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }

			await update_catalog();
			if ( !Storage.Catalog.table_exists ) { return []; }

			// Convert criteria to an sql expression.
			let sql_expression_options = Object.assign( {}, SQL_DIALECT );
			sql_expression_options.AllowedFields = {};
			let payload_sync = ( Storage.Catalog.payload_field !== null ) && Storage.Settings.PayloadSync;
			for ( let key in Storage.Catalog.fields )
			{
				let field = Storage.Catalog.fields[ key ];
				if ( field.is_auto_increment ) { continue; }
				if ( key === SEQ_FIELD ) { continue; }
				if ( key === Storage.Settings.PayloadColumn ) { continue; }
				if ( !'bns'.includes( field.short_type ) ) { continue; }
				// ***The key column is left out under PayloadSync.*** It holds String( _id ), so
				// an ordering criteria on a numeric _id would compare "10" against "5" as text
				// and lose rows. The by-id paths build their own WHERE and still use the index.
				if ( payload_sync && ( key === Storage.Catalog.id_field ) ) { continue; }
				let entry = jsongin.Clone( field );
				// F4. A projected column mirrors the payload and holds NULL where the value did
				// not fit, so every predicate on it is broadened with IS NULL.
				entry.is_projection = payload_sync;
				sql_expression_options.AllowedFields[ key ] = entry;
			}
			// ***The clause narrows the search; the residual decides the answer.***
			let translation = jsonstor.SqlExpression.Translate( {
				Criteria: Criteria,
				Options: sql_expression_options,
			} );
			let sql_expr = translation.Pushdown;

			// Build sql statement.
			let sql = `SELECT * FROM ${table_reference()}`;
			if ( sql_expr ) { sql += ' WHERE ' + sql_expr; }
			// ***A listing is not sorted unless it says so.*** See SEQ_FIELD.
			if ( Storage.Catalog.order_by )
			{
				sql += ' ORDER BY ' + quote_identifier( Storage.Catalog.order_by );
			}

			// Get results.
			let results = await SQL_Passthrough( sql );
			let documents = results.results;

			// Do the actual query filtering here.
			let filtered = [];
			for ( let index = 0; index < documents.length; index++ )
			{
				let document = row_to_document( documents[ index ] );
				if ( jsongin.Query( document, translation.Residual ) )
				{
					filtered.push( document );
					if ( MaxDocs && ( filtered.length === MaxDocs ) ) { break; }
				}
			}

			// ***What the two stages actually did.*** A no-op unless the caller asked for it.
			jsonstor.ReportStatistics( Options, {
				Translator: Storage.SqlTranslation.TranslatorName,
				Pushdown: sql_expr || null,
				PushdownRows: documents.length,
				Residual: translation.Residual,
				ResidualRows: filtered.length,
			} );

			// Return the results.
			return filtered;
		}


		//=====================================================================
		// Refuses an update or a replace which moved the primary key.
		//
		// ***This is the third behavior, and it was the only one which could mislead.*** Measured
		// across the family on 2026-09-03: MongoDB refuses a $set on the identifier, seven
		// adapters honor it, and the five SQL adapters did neither - SQL_Update deletes the key
		// column from the row it writes and then locates the row by the *new* key, so the change
		// was accepted and went nowhere. Refusing by name is the only answer of the three which
		// cannot leave a caller believing something happened.
		//
		// PrimaryKeyMutable: true restores the old permissiveness for a caller who wants it, and
		// then the move is a real one because the key column is written.
		function check_key_move( Before, After )
		{
			if ( Storage.Settings.PrimaryKeyMutable ) { return; }
			let before_key = ( ( Before === null ) || ( typeof Before === 'undefined' ) ) ? null : String( Before );
			let after_key = ( ( After === null ) || ( typeof After === 'undefined' ) ) ? null : String( After );
			if ( before_key === after_key ) { return; }
			throw new Error( `The primary key [${Storage.Catalog.id_field}] is not mutable, and this operation would change it from [${before_key}] to [${after_key}].` );
		}


		//=====================================================================
		// What the identity settings resolved to, once the catalog has been read.
		//
		// ***The key is discovered as often as it is declared***, which is the whole reason this
		// is reported rather than echoed: a configured IdField wins, then _id by name, and only
		// then a foreign table's auto-increment column. A caller asking StorageInfo() gets the
		// one in force rather than the one they passed.
		function refresh_primary_key_info()
		{
			// ***The catalog's answer where there is a table, and the declaration where there is
			// not.*** A storage whose table has not been created yet still has a primary key - it
			// is the one the CREATE TABLE is going to use - and answering with an empty list would
			// report that this storage has no identifier, which is a different fact and a wrong
			// one. Found by asserting it: D) asks straight after DropStorage.
			let field = Storage.Catalog.id_field || Storage.Settings.IdField || DEFAULT_ID_FIELD;
			let column = Storage.Catalog.fields[ field ];
			Storage.PrimaryKeyInfo = {
				Fields: field ? [ field ] : [],
				// ***Read from the catalog and never from a setting.*** The DDL already says what
				// the column holds, and a setting restating it would be two sources for one fact.
				// The family default stands in only while the column does not exist yet.
				Types: field ? [ ( column && column.short_type ) ? column.short_type : jsonstor.PrimaryKey.DEFAULT_TYPE ] : [],
				Mutable: ( Storage.Settings.PrimaryKeyMutable === true ),
				// The server fills it in only where the column says so; otherwise this adapter
				// mints one on insert.
				Generated: !!( column && column.is_auto_increment ),
				// ***The database hosts the index***, which is what a PRIMARY KEY is. jsonstor
				// holds nothing here and RefreshIndex has nothing to rebuild.
				IndexHostedBy: 'database',
			};
			return;
		}


		//=====================================================================
		// The value which goes in the key column.
		//
		// The payload carries the true _id with its true type; this is only what the index
		// holds. An NVARCHAR key takes String() so that the by-id statements compare like with
		// like.
		function id_to_key( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return null; }
			let field = Storage.Catalog.fields[ Storage.Catalog.id_field ];
			if ( field && 'n'.includes( field.short_type ) ) { return Value; }
			return '' + Value;
		}


		//=====================================================================
		function new_id()
		{
			// jsongin's _id is a uuid string, and the built in adapters mint one with uuid.v4()
			// when a document arrives without it. randomUUID is the same value from the runtime,
			// which keeps this adapter's dependencies to its driver.
			return LIB_CRYPTO.randomUUID();
		}


		//=====================================================================
		async function select_by_id( Key )
		{
			let sql = `SELECT * FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let results = await SQL_Passthrough( sql, [ value_to_parameter( Key ) ] );
			if ( !results.results.length ) { return null; }
			return row_to_document( results.results[ 0 ] );
		}


		//=====================================================================
		async function SQL_Insert( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.table_exists ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], it does not exist. Set ModifySchema to true to have it created.` ); }
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], a primary key field was not found. ` ); }
			let id_field = Storage.Catalog.id_field;
			let id_column = Storage.Catalog.fields[ id_field ];
			let auto_increment = !!( id_column && id_column.is_auto_increment );

			// ***The caller's _id is taken as given.*** Only an auto-increment key gets to
			// choose one, and then it is the server which chooses it.
			let document = Document;
			if ( !auto_increment && ( jsongin.ShortType( document[ id_field ] ) === 'u' ) )
			{
				document = jsongin.Clone( Document );
				document[ id_field ] = new_id();
			}

			let row = document_to_row( document );
			if ( !auto_increment ) { row[ id_field ] = id_to_key( document[ id_field ] ); }

			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let names = [];
			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				names.push( quote_identifier( columns[ index ] ) );
				tokens.push( parameter_token( index + 1 ) );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			// ***OUTPUT INSERTED is this engine's RETURNING***, and it sits before VALUES rather
			// than after. better-sqlite3 answers a lastInsertRowid and mysql2 an insertId; here
			// as in Postgres the server is asked to hand the column back, which is one round
			// trip rather than two.
			let sql = `INSERT INTO ${table_reference()} ( ${names.join( ', ' )} )`
				+ ` OUTPUT INSERTED.${quote_identifier( id_field )}`
				+ ` VALUES ( ${tokens.join( ', ' )} )`;

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			let key = auto_increment ? results.results[ 0 ][ id_field ] : row[ id_field ];
			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Update( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot update rows in table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			let id_field = Storage.Catalog.id_field;
			if ( jsongin.ShortType( Document[ id_field ] ) === 'u' ) { throw new Error( `Cannot update this document, it is missing the id field [${id_field}].` ); }

			let row = document_to_row( Document );
			delete row[ id_field ];
			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				tokens.push( `${quote_identifier( columns[ index ] )} = ${parameter_token( index + 1 )}` );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let key = id_to_key( Document[ id_field ] );
			let sql = `UPDATE ${table_reference()} SET ${tokens.join( ', ' )}`
				+ ` WHERE (${quote_identifier( id_field )} = ${parameter_token( columns.length + 1 )})`;
			sql_parameters.push( value_to_parameter( key ) );

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Delete( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();

			// Get the _id field.
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot delete rows from table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			if ( jsongin.ShortType( Document[ Storage.Catalog.id_field ] ) === 'u' ) { throw new Error( `Cannot delete this document, it is missing the id field [${Storage.Catalog.id_field}].` ); }

			let sql = `DELETE FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let sql_parameters = [ value_to_parameter( id_to_key( Document[ Storage.Catalog.id_field ] ) ) ];

			// Get results.
			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return false; }

			return true;
		}


		//=====================================================================
		// SqlTranslation
		//
		// ***What a clause-translating adapter advertises beyond the Storage interface.***
		// This is how a shared suite, or any other caller, can ask what this adapter would
		// render and then ask the server what that rendering admits.
		//
		// ***Its presence is the capability declaration.*** An adapter which does not push a
		// clause down does not define it, and a suite which needs one skips that engine
		// rather than consulting a second list somewhere which could disagree.
		//=====================================================================

		Storage.SqlTranslation = {
			TranslatorName: 'SqlExpression',
			DialectName: 'mssql',

			// The options this adapter renders with. A copy, so a caller cannot alter them.
			Dialect: function () { return Object.assign( {}, SQL_DIALECT ); },

			// ***A logical type to this engine's spelling for it.*** A shared suite declares the
			// columns it wants in jsongin's own short types and cannot know what to call them
			// here - and a column's declared type is the promise this adapter keeps by writing
			// NULL where a value does not match it, so the suite must not guess.
			//
			// ***`b` is a BIT, which is this engine's boolean.*** Unlike Oracle's NUMBER(1) it
			// reads back as a JavaScript boolean, so a boolean does pre-filter here - the clause
			// simply compares it against 1 and 0, which is what BooleanLiterals says.
			ColumnTypes: {
				b: 'BIT',
				n: 'FLOAT',
				s: 'NVARCHAR(4000)',
				i: 'INT',
			},

			// ***How this engine spells a bound parameter.*** Named rather than positional, and
			// the name is what SQL_Passthrough binds the array's entries to.
			ParameterToken: function ( Index ) { return parameter_token( Index ); },

			// ***Normalized on purpose.*** SQL_Passthrough is not advertised directly because
			// the SQL adapters do not agree about it. A surface whose contract differs between
			// its implementations is worse than none, so callers get rows, or a promise that
			// the statement ran.
			Query: async function ( Sql, Parameters ) { return ( await SQL_Passthrough( Sql, Parameters || [] ) ).results; },
			Execute: async function ( Sql ) { return await SQL_Execute( Sql ); },
		};

		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***What this storage is actually talking to.*** `SERVERPROPERTY('ProductVersion')` is
		// the comparable number - `16.0.4265.3` - and `@@VERSION` is the whole banner, which
		// names the product and the build and is worth keeping verbatim beside it.
		Storage.StorageInfo = async function ( Options )
		{
			let answer = await SQL_Passthrough(
				`SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS server_version, @@VERSION AS banner` );
			let row = answer.results[ 0 ] || {};
			let banner = ( row.banner || '' ).split( '\n' )[ 0 ].trim();
			// ***The catalog is read before the answer is assembled***, because the primary key
			// this reports is the discovered one and not the declared one.
			//
			// ***Only when nobody else is already reading it.*** This function is re-entered from
			// underneath: a statement calls update_catalog(), which reaches ensure_dialect_checked(),
			// which calls StorageInfo(). Awaiting update_catalog() there awaits the very promise the
			// outer frame is waiting on, and the storage deadlocks rather than recursing - it hangs
			// with no stack to read. The guard is the one ensure_dialect_checked() already writes
			// three lines above its own call, for the same reason.
			if ( !Storage.Catalog.initialized && ( catalog_read === null ) ) { await update_catalog(); }
			refresh_primary_key_info();
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'MS Sql Server',
				Version: row.server_version || '',
				Banner: banner,
				Endpoint: `${Storage.Settings.Server}:${Storage.Settings.Port}`,
			} );
		};


		Storage.DropStorage = async function ( Options )
		{
			await SQL_Execute( `DROP TABLE IF EXISTS ${table_reference()}` );
			Storage.Catalog.initialized = false;
			await update_catalog();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***A no-op which answers 0, and means it.*** The index is the table's PRIMARY KEY and
		// the server maintains it; there is nothing here which could go stale and nothing to
		// rebuild. It is implemented rather than left to the interface stub because the stub
		// throws, and an adapter which simply has no index to refresh is not an adapter which
		// forgot to write this. See jsonx/.plans/primary-keys-and-indexes.md.
		Storage.RefreshIndex = async function ( Options )
		{
			return 0;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			return documents.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options = {} )
		{
			let document = await SQL_Insert( Document );
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options = {} )
		{
			let documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				documents.push( await SQL_Insert( Documents[ index ] ) );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options = {} )
		{
			// A read returns documents. ReturnDocuments gates what a *write* hands back, which
			// is how the built in adapters read: their FindOne, FindMany and FindMany2 never
			// consult it.
			let documents = await SQL_Query( Criteria, 1, Options );
			if ( !documents.length ) { return null; }
			if ( Projection )
			{
				documents[ 0 ] = jsongin.Project( documents[ 0 ], Projection );
			}
			return documents[ 0 ];
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, MaxCount, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length > MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				let previous_key = document[ Storage.Catalog.id_field ];
				document = jsongin.Update( document, Update );
				check_key_move( previous_key, document[ Storage.Catalog.id_field ] );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				let previous_key = documents[ index ][ Storage.Catalog.id_field ];
				documents[ index ] = jsongin.Update( documents[ index ], Update );
				check_key_move( previous_key, documents[ index ][ Storage.Catalog.id_field ] );
				documents[ index ] = await SQL_Update( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				let previous_key = document[ Storage.Catalog.id_field ];
				if ( Document )
				{
					for ( let key in Document )
					{
						document[ key ] = Document[ key ];
					}
				}
				// ***A replacement carrying no primary key keeps the matched document's key***,
				// which this path has always done because it merges rather than replaces. What is
				// new is that a replacement carrying a *different* key is refused rather than
				// written to a row which does not exist.
				check_key_move( previous_key, document[ Storage.Catalog.id_field ] );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				let result = await SQL_Delete( documents[ 0 ] );
				if ( result )
				{
					document = documents[ 0 ];
				}
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				await SQL_Delete( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is one prime and five aliases.***
//
// SQL Server 14.0.3540.1 (2017), 15.0.4480.2 (2019) and 16.0.4265.3 (2022) were measured against
// this adapter on 2026-09-01. ***All three answered identically*** - the same DDL, the same
// catalog reads, the same translator options - so there is one dialect profile here.
//
// ***The floor is 14.0, and it is the oldest one that can exist rather than the oldest one
// anyone happened to start.*** SQL Server did not run on Linux before 2017, so there is no
// container below this to measure. That is a harder floor than PostgreSql's: Postgres 9.6 runs
// and refuses the DDL, where SQL Server 2016 cannot be stood up at all.
//
// ***Naming this `-v16.0` would have understated the adapter by two major versions***, which is
// the same mistake `jsonstor-postgres` was one commit away from making. The container that
// happens to be running is not the floor.
//
// See jsonx/.plans/versioned-adapters.md.

const MSSQL_V14 = {
	AdapterName: 'jsonstor-mssql-v14.0',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	// ***The floor this profile starts at.*** SQL Server 2017 is the first release with a Linux
	// container, so nothing below it is reachable by this family's test environment.
	Version: [ 14, 0 ],
	// ***The newest server it has actually been run against***, at the precision it was measured
	// at - the comparison zero-pads, so a short answer claims less than was run and makes the
	// prime warn about its own test server.
	MeasuredTo: [ 16, 0, 4265, 3 ],
};

module.exports.Adapters = [ MSSQL_V14 ];

// ***The bare name is listed here rather than left on the plugin object.*** Naming it stops
// the plugin registering itself under it, so `GetStorage( 'jsonstor-mssql' )` reports the prime
// it resolved to instead of reporting itself as its own dialect.
module.exports.Aliases = {
	'jsonstor-mssql': 'jsonstor-mssql-v14.0',
	'jsonstor-mssql-v14': 'jsonstor-mssql-v14.0',
	'jsonstor-mssql-v15': 'jsonstor-mssql-v14.0',
	'jsonstor-mssql-v15.0': 'jsonstor-mssql-v14.0',
	'jsonstor-mssql-v16': 'jsonstor-mssql-v14.0',
	'jsonstor-mssql-v16.0': 'jsonstor-mssql-v14.0',
};
