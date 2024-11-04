const { kMaxLength } = require('buffer');
const { validateHeaderName } = require('http');
const net = require('net');

// type describes hte structure of an object that represents an HTTP request
type HTTPReq = {
    method: String, // (GET, POST, etc)
    uri: Buffer; //requested uri (/index.html)
    version: String, // http version(http/1.1) 
    headers: Buffer[], // array of headers, each header is stored in buffer
};

// an HTTP response
type HTTPRes = {
    code: Number, // status code (200, 404)
    headers: Buffer[], // array of headers
    body: BodyReader, // object or function that reads and processes the response 
    //bodyreader is the interface for reading data from the body payload
};

// interface for reading/writing data from/to the HTTP body
type BodyReader = {
    // the "Content-Length", -1 if unknown.
    length: Number,
    // read data. returns an empty buffer after EOF
    read: () => Promise<Buffer>
    // reads data from the body. It returns a promise that resolves to a buffer containing the data
    // When EOF is reached, it returns an empty Buffer
}

async function serveClient(conn: TCPConn): Promise<void>{
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0 } // initialized as empty buffer, length tracks how much valid data is in the buffer
    while (true){
        //try to get 1 request header from the buffer
        const msg: null|HTTPReq = cutMessage(buf); // if it parses HTTPReq object, it returns it, if not, returns NULL
        if (!msg){
            // need more data to form an HTTP request
            const data = await soRead(conn); //reads more data from the client connection asynchronously
            bufPush( buf, data ); // appends new data to buffer for further processing
            // EOF 
            if (data.length === 0 && buf.length === 0){
                return; // no more requests, client closed connection
            }
            if (data.length === 0){ // no new data was read buf buffer is not empty
                throw new HTTPError(400, 'Unexpected EOF.'); // connectin was closed unexpectedly
            }
            continue; 
            //got some data, try to parse a complete HTTP request from updated buffer.
        }

        //process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg); // interface that allows reading the body of the HTTP request
        const res: HTTPRes = await handleReq(msg, reqBody); // handles http request 'msg' and associated body 'reqBody'. returns http response
        await writeHTTPResp(conn, res); // sends 'res' back to the client through the connection 'conn' 
        //close the connectino for HTTP/1.0
        if (msg.version === 'HTTP/1.0'){
            return;
        }
        // ensures that the request body is read and consumed completly
        while ( (await reqBody.read()).length > 0 ){ /* empty */}
        // reqBody.read(): method reads data from the request body. It returns a 'promise' resolving to a buffer containing data
    }
}
/* HTTPError is a custom exception type. Used to generate an error response and close the conectoin. It defers the case of error handling. Not adequate in production code */
async function newConn(socket: net.Socket) {
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(conn);
    }
    catch (exc){
        console.error('exception:', exc);
        if (exc instanceof HTTPError){
            // intended to send an error response
            const resp: HTTPRes = {
                code: exc.code,
                headers:[],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
        }
        try {
            await writeHTTPResp(conn, resp);
        }
        catch (exc){ /* ignore */}
    }
    finally {
        socket.destroy();
    }
}

//the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

//parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null|HTTPReq {
    // the end of the header is marked by '\r\n\r\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n'); //indexOf searches for the first instance of '\r\n\r\n'. subarray, makes a slice at index 0 to length of buf
    if (idx < 0) { // checks if '\r\n\r\n' was found, if not found, it'll be -1
        if (buf.length >= kMaxLength) {
            throw new HTTPError(413, 'header is too large');
        }
        return null; // need more data
    }
    // parse & remove the header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4); // removes the parsed header from the buffer. buffer is then ready to receive more data or process the next part of the message
    return msg;
}

// parse an HTTP request header
function parseHTTPReq( data: Buffer ) {
    // split the data into lines
    const lines: Buffer[] = splitLines(data); // each line is seperated by "\r\n"
    // the first line is 'METHOD URI VERSION'
    const [method, uri, version] = parseRequestLine(lines[0]); // The first line contains the following ex: 'GET', '/index.html', 'HTTP/1.1'
    // followed by header fileds in the format of 'Name: value'
    const headers: Buffer[] = [];
    for (let i = 1; i < lines.length - 1; i++){ // loops through remaining lines
        const h = Buffer.from(lines[i]); //copy
        if (!validateHeaderName(h)){ // each line is checked to ensure it is a valid header
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h); // line is stored in 'headers' array
    }
    // the header ends by an empty line
    console.assert(lines[lines.length - 1].length === 0); // ensures that the header section must end with an empty line
    return {
        method: method, uri: uri, version: version, headers: headers,
    };
}

// BodyReader from an HTTP request 
function readerFromReq( conn: TCPConn, buf: DynBuf, req: HTTPReq ) : BodyReader {
    let bodyLen = -1; // len of body is unknown
    const contentLen = fieldGet( req.headers, 'Content-Length' ); // header specifies length of body
    if (contentLen){ // if clen is present, it converts it from bytes to a string using 'latin1' encoding, parses it as a decimal number
        bodyLen = parseDec( contentLen.toString('latin1'));  // asigns it to bodylen
        if ( isNaN(bodyLen) ){ // if header is malformed, error is thrown
            throw new HTTPError(400, 'bad Content-Length');
        }
    }
    const bodyAllowed = !( req.method === 'GET' || req.method === 'HEAD' ); // GET and HEAD don't have body
    const chunked = fieldget( req.headers, 'Transfer-Encoding' )
        ?.equals(Buffer.from('chunked')) || false; // checks if 'Transfer-Encoding' header is set to 'chunked' indicating body is sent in chunks
    if ( !bodyAllowed && (bodyLen > 0 || chunked) ){ 
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    if (!bodyAllowed){
        bodyLen = 0;
    }
    if (bodyLen >= 0){
        return readerFromConnLength(conn, buf, bodyLen); // returns 'BODYREADER' reading exactly 'bodylen' bytes from the connection 
    }
    else if (chunked){
        //chunked encoding
        throw new HTTPError(501, 'TODO'); // feature not yet implemented
    }
    else {
        //read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }
}

function fieldGet(headers: Buffer[], key: string): null|Buffer {
    // Convert the key to lowercase for case-insensitive comparison
    const lowerKey = key.toLowerCase();
    
    // Iterate through each header in the headers array
    for (const header of headers) {
        // Convert the header to a string using 'latin1' encoding for comparison
        const headerStr = header.toString('latin1');
        
        // Find the position of the colon, which separates the name and value
        const colonIndex = headerStr.indexOf(':');
        if (colonIndex > 0) {
            // Extract the name part and convert it to lowercase
            const headerName = headerStr.slice(0, colonIndex).trim().toLowerCase();
            
            // Compare the extracted name with the key
            if (headerName === lowerKey) {
                // Return the value part as a Buffer, trimming any leading/trailing spaces
                const value = headerStr.slice(colonIndex + 1).trim();
                return Buffer.from(value, 'latin1');
            }
        }
    }
    
    // Return null if the key is not found in any header
    return null;
}

// BODY READER READS FROM A SOCKET WITH A KNOWN LENGTH (REMAIN)
function readerFromConnLength( conn: TCPConn, buf : DynBuf, remain: number ): BodyReader{
    // returns an object type 'bodyreader' . 'length' the number of bytes that should be read,
    return { 
        length: remain
        read: async (): Promise<Buffer> => { //  'read' an asynchronous function that reads the data from the connection, returning a 'Buffer' containing data
            if (remain === 0){
                return Buffer.from(''); // done, returns an empty buffer
            }
            if (buf.length === 0){ // there is no data currently try to get some data if there is none
                const data = await soRead(conn);
                bufPush(buf, data); // store data in buffer
                if (data.length === 0){
                    // expect more data! The connection ended without sending enough data
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // consume data from the buffer
            const consume = Math.min(buf.length, remain);// minues operation
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume)); // a buffer created to store the consumed data is made and returned
            bufPop(buf, consume); // consumed bytes are removed from buffer
            return data; 
        }
    };
}

// a sample request handler
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes>{
    // act on the request URI
    let resp: BodyReader;
    switch (req.uri.toString('latin1')){ // function cheks the incoming request by converting to str 
        case '/echo':
            //if echo, server will act as an echo server. http echo server
            resp = body
            break; // for any other URI, the server responds with a simple "Hello world" message. The resp variable is set to a BodyReader that reads this message from memory.
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'));
            break;
        }
    return{
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp
    };
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader{
    let done = false; // used to track whether data has already been read.
    return {// retunrs the total length of the data that can be read. Read: asynchronous f unction that returns data when called
        length: data.length, 
        read: async(): Promise<Buffer> => { // first tim eit's called, it returns the fulld data. Any subsequent calls return empty buffer
            if (done){
                return Buffer.from(''); // no more data
            }
            else{
                done = true;
                return data;
            }
        }
    }
}

// send an http response through the socket
async function writeHTTPResp( conn: TCPConn, resp: HTTPRes): Promise<void>{
    if (resp.body.length < 0){
        throw new Error('TODO: chunked encoding');
    }
    // set the "content length" field
    console.assert(!fieldGet(resp.headers, 'Content-Length'));// tells the cliet how mudh data to expect in the body of the response.
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    //write the header
    await soWrite(conn, encodeHTTPResp(resp));
    //write the body
    while(true){
        const data = await resp.body.read();
        if (data.length === 0){
            break;
        }
        await soWrite(conn, data);
    }
}

async function serveClient(conn: TCPConn): Promise<void> { // operates asynchronously and doesn't return any specific value
    const buf: DynBuf = {data: Buffer.alloc(0), length:0};
    while(true){
        // try to get 1 request header from the buffer
        const msg: null|HTTPReq = cutMessage(buf); // try to extract HTTP request
        if (!msg){
            // ommitted // loop continues without processing
            continue;
        }
        // process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if (msg.version === '1.0'){
            return;
        }
        // make sure that the request body is consumed completely
        while (( await reqBody.read()).length > 0){ /* empty */} // before continuing the next iteration of the loop,
        // function ensures the entire body of the current request has been consumed. 
        // The reason why the entire request body must be read, even after the response has already been written to the socket, is to ensure that the connection is properly prepared for any subsequent requests the client might send. This is particularly important when dealing with persistent connections (like those in HTTP/1.1) where multiple requests can be sent over the same connection (a feature known as "keep-alive").
    } // loop for 10
}
