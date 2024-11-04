// import * as net from "net"; // all networking stuff is in the net module
const net = require('net');

// accept primitive : Accept new connections
async function newConn(socket) {
    console.log('new connection', socket.remoteAddress, socket.remotePort);

    try {
        await serveClient(socket);
    } catch (exc){
        console.error('exception:', exc);
    } finally {
        socket.destroy();
    }

    socket.on('end', ()=> {
        // FIN received. The connection will be closed automatically.
        console.log('EOF.');
    });

    socket.on('data', (data, Buffer) => {
        console.log('data:', data);
        socket.write(data); // echo back the data

        // actively closed the connection if the data contains 'q'
        if (data.includes('q')){
            console.log('closing.');
            socket.end(); //this will send FIN and close the connection
        }
    });
}

let server = net.createServer({allowHalfOpen: true}); // creates a listening socket whose type is net.Server
server.on('error', (err) => { throw err; }); // if 2 servers run on the same address port, second server will fail
server.on('connection', newConn); // registers callback function newconn. The runtime will automatically perform the ACCEPT operation and invoke the callback with the new connection as an argument of type net.Socket. Callback is registered once but will be called for each new connection.
server.listen({host: '127.0.0.1', port: 1234}); // net.Server has a listen method to bind and listen on an address


