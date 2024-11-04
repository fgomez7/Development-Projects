const { kMaxLength } = require('buffer');
// const { validateHeaderName } = require('http');
const net = require('net');

class HTTPError extends Error {
    constructor(code, message) {
        super(message);             // Call the parent class (Error) constructor with the message
        this.name = 'HTTPError';    // Name the error type
        this.code = code;           // Add a custom property for the HTTP status code
    }
}

module.exports = HTTPError;

// HTTP Request structure
function HTTPReq(method, uri, version, headers) {
    return {
        method: method,     // (GET, POST, etc)
        uri: uri,           // requested URI (/index.html)
        version: version,   // HTTP version (HTTP/1.1)
        headers: headers    // array of headers, each header is stored in Buffer
    };
}

// HTTP Response structure
function HTTPRes(code, headers, body) {
    return {
        code: code,          // status code (200, 404)
        headers: headers,    // array of headers
        body: body           // BodyReader: object or function that reads and processes the response
    };
}

// BodyReader structure
function BodyReader(length, read) {
    return {
        length: length,      // the "Content-Length", -1 if unknown
        read: read           // prepares the mechanism for reading, actual reading happens 'read' method is invoked
    };
}

// Create a wrapper for net.Socket. Sets up event handlers to manage data, end, and error events on connection
function soInit(socket) {
    const conn = {          // initializes conn object
        socket: socket, 
        err: null,          // init to null, will store any errors that occur duing connection
        ended: false,       // set to true when conn is closed
        reader: null,       // holds resolve reject functions of a promise when data is being read asynchronously
    };

    /*  socket.on sets up event handler triggered when data is recieved on socket
        if conn.reader is not null, someone is waiting for data (promise pending) 
        conn.socket.pause stops data even from emitting until next read operation is initiated
        conn.reader.resolve completes the promise by pasing received data to it. allowing the caller of 'soRead' function to get the data they were waiting for
        conn.reader = null resets the reader indicating that the current read operation is complete
    */
    socket.on('data', (data) => {
        if (conn.reader) {
            // Pause the 'data' event until the next read
            conn.socket.pause();
            // Fulfill the promise of the current read
            conn.reader.resolve(data);
            conn.reader = null;
        }
    });

    /*  conn.ended = true; marks the connection as ended
        Resolving pending read: if someone is waiting for data ('conn.reader' is not null), resolve the promise with an empty buffer (Buffer.from('')) to signify the EOF
        conn.reader = null; resets the reader as the connection has ended
    */
    socket.on('end', () => {//event is triggered when the connection is closed by the remote end
        conn.ended = true;
        if (conn.reader) {
            conn.reader.resolve(Buffer.from('')); // EOF
            conn.reader = null;
        }
    });

    /*  conn.err; stores the error in the 'conn' object
        Reject pending read: if there's a pending read, reject the promise with error. 
        conn.reader = null; resets the reader bc operation is now completed
    */
    socket.on('error', (err) => { // event handler triggered when error occurs on the socket
        conn.err = err;
        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    });

    return conn;
}

/*  console.assert; ensures no concurrent reads are happening. conn.reader should == null when new read operation starts
    console.assert; if reader is not null, means there is a pending read operation, assertion fails, logic error in program
    returns a 'Promise', allowing caller to use 'await' or '.then()' to handle result of read operation asynchronously. 'resolve' and 'reject' promise are provided by 'Promise' used to complete the read operation, either success or with error
    conn.err; if connection encountered an error, promise immediately rejected with error
    conn.ended; if connection has ended, promise immediately resolved with an empty buffer (EOF)
    conn.reader; function calls ' conn.socket.resume()' to resume the data event. Means socket is ready to receive more data, when data arrives, the 'data' event will fire, triggering handler defined in 'soInit', fulfilling promise by calling 'resolve(data)'
 */
function soRead(conn) { // Returns an empty 'Buffer' after EOF
    console.assert(!conn.reader); // No concurrent calls
    return new Promise((resolve, reject) => {
        // If the connection is not readable, complete the promise now
        if (conn.err) {
            reject(conn.err);
            return;
        }
        if (conn.ended) {
            resolve(Buffer.from('')); 
            return;
        }

        // Save the promise callbacks
        conn.reader = { resolve: resolve, reject: reject };
        conn.socket.resume();
    });
}

/*  console.assert; checks data you're sending is not empty. used to enforce data > 0. If it fails, error will be thrown in console
    conn.err; is not null, an error already occurred on this connection. function rejects promise with stored error
    conn.socket.write; attempts to send data over TCP connection. callback function to write is called when operation is completed
    reject(err); if error occurs, promise is rejected and error is passed to caller. allowing caller to handle error appropiately
    resolve(); no error, promise is resolved without any arguments, signaling operation is successful.
 */
function soWrite(conn, data) { // data is what you want to send over the conn, in form of a byte string

    console.assert(data.length > 0);
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
/*  buf has current data which includes the actual data (buf.data) and length of data(buf.data.len)
    allocate new memory of the new data that needs to be pushed onto it. 
    grown is the new buffer allocated with a big enough memory for the current data and new data
    contents of buf.data is copied over to grown and buf.data is set to equal to grown. 
    new data is pushed onto buf.data starting from buf.length. 
    set buf.length = newLen
 */
function bufPush(buf, data) { // pushes data to buffer
    const newLen = buf.length + data.length;
    if (buf.data.length < newLen) {
        // grow the capacity by the power of two
        let cap = Math.max(buf.data.length, 32);
        while (cap < newLen) {
            cap *= 2;
        }
        const grown = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }
    data.copy(buf.data, buf.length, 0);
    buf.length = newLen;
}

/*  'helloworld', bufPop(buf, 5). copywithin() copies onto the buffer the data within buffer. 
    copyWithin(0, len, buf.length) = (0, 5, 10) = buf = 'world'. copy at index 0 starting from index 5
 */
function bufPop(buf, len){
    buf.data.copyWithin(0, len, buf.length);
    buf.length -= len;
}

async function serveClient(conn) { // READS DATA FROM CLIENT CONNECTION, PARSES HTTP REQ
    const buf = { data: Buffer.alloc(0), length: 0 }; // initialized as an empty buffer
    while (true) {
        // Try to get 1 request header from the buffer
        const msg = cutMessage(buf); // if it parses HTTPReq object, it returns it; if not, returns null
        if (!msg) {
            // Need more data to form an HTTP request
            const data = await soRead(conn); // reads more data from the client connection asynchronously
            bufPush(buf, data); // appends new data to buffer for further processing

            // EOF
            if (data.length === 0 && buf.length === 0) {
                return; // no more requests, client closed connection
            }
            if (data.length === 0) { // no new data was read but buffer is not empty
                throw new HTTPError(400, 'Unexpected EOF.'); // connection was closed unexpectedly
            }
            continue; 
        }

        // Process the message and send the response
        const reqBody = readerFromReq(conn, buf, msg); // interface that allows reading the body of the HTTP request
        const res = await handleReq(msg, reqBody); // handles HTTP request 'msg' and associated body 'reqBody', returns HTTP response
        await writeHTTPResp(conn, res); // sends 'res' back to the client through the connection 'conn' 

        // Close the connection for HTTP/1.0
        if (msg.version === 'HTTP/1.0') {
            return;
        }

        // Ensure that the request body is read and consumed completely
        while ((await reqBody.read()).length > 0) { /* empty */ }
    }
}

async function newConn(socket) { // CALLED WHEN CLIENT CONNECTS TO A SERVER 
    const conn = soInit(socket); // initializes the connection, DELEGATES HANDLING
    try {
        await serveClient(conn);
    } catch (exc) {
        console.error('exception:', exc);
        if (exc instanceof HTTPError) {
            const resp = HTTPRes(
                exc.code,
                [],
                readerFromMemory(Buffer.from(exc.message + '\n'))
            );
            try {
                await writeHTTPResp(conn, resp);
            } catch (exc) { /* ignore */ }
        }
    } finally {
        socket.destroy();
    }
}

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// parse & remove a header from the beginning of the buffer splitting off the first instance of '\r\n\r\n'
function cutMessage(buf) {
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if (idx < 0) {
        if (buf.length >= kMaxLength) {
            throw new HTTPError(413, 'header is too large');
        }
        return null;
    }
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4);
    return msg;
}

function splitLines(data){
    return data.toString().split('\r\n')
}

function parseRequestLine(line) {
    // Split the request line by spaces
    const parts = line.split(' ');

    // Ensure the request line has exactly 3 parts: method, URI, and version
    if (parts.length !== 3) {
        throw new HTTPError(400, 'Invalid request line');
    }

    const [method, uri, version] = parts;

    // Additional validation can be added here if necessary
    // For example, you could validate the method, uri, and version formats

    return [method, uri, version];
    // returns array containing method, uri, version
}

/*  parse an HTTP request header 
    loops through every header and makes sure that each header is a valid header
    pushes valid headers onto headers array
    asserts the last line of httpreq is an eof
    return HTTPReq object
 */
function parseHTTPReq(data) {
    const lines = splitLines(data);
    const [method, uri, version] = parseRequestLine(lines[0]);
    const headers = [];
    for (let i = 1; i < lines.length - 2; i++) {
        if (lines[i].length === 0){
            break
        }
        const h = Buffer.from(lines[i]);
        if (!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    console.assert(lines[lines.length - 1].length === 0);
    return HTTPReq(method, uri, version, headers);
}

// function validateHeader(headerBuffer) {
//     // Convert the buffer to a string and split it into name and value parts
//     const header = headerBuffer.toString();
//     const [name, ...valueParts] = header.split(':');
    
//     // Validate the header name using the imported validateHeaderName function
//     const arg = name.trim();
//     if (!validateHeaderName(name.trim())) {
//         return false;
//     }
    
//     // Optionally validate the header value (for example, ensure it's not empty)
//     const value = valueParts.join(':').trim();
//     if (value.length === 0) {
//         return false; // or you could throw an error if a valid header requires a value
//     }
    
//     return true;
// }

function validateHeader(header) {
    // Convert the header name to a string
    const headerName = header.toString('ascii');
    const [name, ...valueParts] = headerName.split(':');

    // Check if the header name contains only valid characters
    // Valid characters are letters, digits, hyphens (-), and underscores (_)
    // According to RFC 7230, the valid characters for a header name are token characters.
    const validHeaderName = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;

    // Test the header name against the valid characters regex
    return validHeaderName.test(name);
}

function parseDec(integer){     // turns string to integer
    return (integer = +integer)
}

/*  BodyReader from an HTTP request 
    contentLen; gets the length of the body
    if (isNaN(bodylen)); assures content-length is an actual number
    bodyallowed; bodies aren't allowed on GET or HEAD, just post
    chunked; checks if 'Transfer-Encoding' header is set to 'chunked' indicating body is sent in chunks

*/
function readerFromReq(conn, buf, req) {
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if (contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked = fieldGet(req.headers, 'Transfer-Encoding')
        ?.equals(Buffer.from('chunked')) || false;

    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    if (!bodyAllowed) {
        bodyLen = 0;
    }
    if (bodyLen >= 0) {
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        throw new HTTPError(501, 'TODO');
    } else {
        throw new HTTPError(501, 'TODO');
    }
}

/*  with 'key', it loops through all headers until header matches key
    once found, it returns the value associated with the key
 */
function fieldGet(headers, key) {
    const lowerKey = key.toLowerCase();
    for (const header of headers) {
        const headerStr = header.toString('latin1');
        const colonIndex = headerStr.indexOf(':');
        if (colonIndex > 0) {
            const headerName = headerStr.slice(0, colonIndex).trim().toLowerCase();
            if (headerName === lowerKey) {
                const value = headerStr.slice(colonIndex + 1).trim();
                return Buffer.from(value, 'latin1');
            }
        }
    }
    return null;
}

/*  returns an object type 'bodyreader' . 'length' the number of bytes that should be read,
    'read' an asynchronous function that reads the data from the connection, returning a 'Buffer' containing data
    if remain === 0; return EOF or ''
    if buf.length === 0; there is no data currently try to get some data if there is none
    bufPush(buf, data); push new data onto buffer

*/
function readerFromConnLength(conn, buf, remain) { //remain is body length
    return {
        length: remain,
        read: async () => {
            if (remain === 0) {
                return Buffer.from(''); 
            }
            if (buf.length === 0) {
                const data = await soRead(conn);
                bufPush(buf, data);
                if (data.length === 0) {
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            const consume = Math.min(buf.length, remain);   // holds the number of bytes that will be consumed from buffer
            remain -= consume;                              // subtracts the numbe rof bytes we're about to consume from remain
            const data = Buffer.from(buf.data.subarray(0, consume)); //creates a subarray of buffer data starting from '0' and taking consume bytes
            bufPop(buf, consume);   //removes the consumed bytes from the front of the buffer.
            return data;            // returns the extracted data, 
        }
    };
}

/*  if request is echo, than the response will = the body
    otherwise; function sets 'resp' to be a simple message 'hello world' using 'readerfrommemory'
    returns an httpres object. holding the status code, the identity of the server, and resp
 */
async function handleReq(req, body) {
    let resp;
    switch (req.uri.toString('latin1')) {
        case '/echo':
            resp = body;
            break;
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'));
            break;
    }
    return HTTPRes(
        200,
        [Buffer.from('Server: my_first_http_server')],
        resp
    );
}

/*  done; keeps track if the data has been read, set to false as default
    if (done); returns an end of file
*/
function readerFromMemory(data) {
    let done = false;
    return BodyReader(
        data.length,
        async () => {
            if (done) {
                return Buffer.from('');
            } else {
                done = true;
                return data;
            }
        }
    );
}

function encodeHTTPResp(resp){
    const statusLine = `HTTP/1.1 ${resp.code}\r\n`;
    const headers = resp.headers.map( h=> h.toString('utf-8')).join('\r\n');
    const headerSection = `${statusLine}${headers}\r\n\r\n`;

    return Buffer.from(headerSection, 'utf-8');
}

/*  send an http response through the socket 
    console.assert(); makes sure content-length is not set
    adds 'content-length' header to the response
    encodes the response headers into a format suitable for sending over the network
    soWrite then writes the encoded headers to the connection ('conn')
    loop; responsible for sending response body in chunks
    resp.body.read; reads a chunk of data, method returns a 'buffer' containing the data
    if data.length == 0; data has been read, break
*/  
async function writeHTTPResp(conn, resp) {
    if (resp.body.length < 0) {
        throw new Error('TODO: chunked encoding');
    }
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    await soWrite(conn, encodeHTTPResp(resp));
    while (true) {
        const data = await resp.body.read();
        if (data.length === 0) {
            break;
        }
        await soWrite(conn, data);
    }
}

// Your existing `newConn` function and other related code here

// Create a server instance
let server = net.createServer({ allowHalfOpen: true });

// Handle any errors that might occur
server.on('error', (err) => { 
    throw err; 
});

// Register the callback function `newConn` to handle new connections
server.on('connection', newConn);

// Start the server and have it listen on a specific address and port
server.listen({ host: '127.0.0.1', port: 1234 }, () => {
    console.log('Server is listening on 127.0.0.1:1234');
});
