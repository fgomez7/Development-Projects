from gevent import socket #allows non blocking socket operations
from gevent.pool import Pool # manages fixed number of greenlets
from gevent.server import StreamServer # a basic tcp server, handles incoming client connections using greenlets

from collections import namedtuple
from io import BytesIO # an in - memory stream for bytes
from socket import error as socket_error # exception for socket-related errors
import logging


logger = logging.getLogger(__name__)


class CommandError(Exception): pass #exception raised with problem with a command sent by client
class Disconnect(Exception): pass # exception raised when client disconnects

Error = namedtuple('Error', ('message',)) # a simple named tuple with one field, 'message'. Used to represent message in a structured way
client_side = 10
server_side = 20


class ProtocolHandler(object):
    def __init__(self):
        self.handlers = {
            b'+': self.handle_simple_string,
            b'-': self.handle_error,
            b':': self.handle_integer,
            b'$': self.handle_string,
            b'*': self.handle_array,
            b'%': self.handle_dict}

    def handle_request(self, socket_file, system_side): # parse a request from the client 
        first_byte = socket_file.read(1)
        # print("hello:",first_byte.decode('ascii')) # THIS WORKS
        if not first_byte:
            raise Disconnect()

        try:
            # Delegate to the appropriate handler based on the first byte.
            return self.handlers[first_byte](socket_file, system_side)
        except KeyError:
            raise CommandError('bad request')

    def handle_simple_string(self, socket_file, system_side):
        if system_side == server_side:
            return socket_file.readline().rstrip(b'\r\n')
        else:
            data = socket_file.readline().rstrip(b'\r\n')
            return data.decode('ascii')

    def handle_error(self, socket_file, system_side):
        if system_side == server_side:
            return Error(socket_file.readline().rstrip(b'\r\n'))
        else:
            data = socket_file.readline().rstrip(b'\r\n')
            return Error(data.decode('ascii'))

    def handle_integer(self, socket_file, system_side):
        return int(socket_file.readline().rstrip(b'\r\n'))

    def handle_string(self, socket_file, system_side):
        # First read the length ($<length>\r\n).
        length = int(socket_file.readline().rstrip(b'\r\n'))
        if length == -1:
            return None  # Special-case for NULLs.
        length += 2  # Include the trailing \r\n in count.
        if system_side == server_side:
            return socket_file.read(length)[:-2] # returns bytes excluding trailing \r\n
        else:
            data = socket_file.read(length)[:-2]
            return data.decode('ascii')

    def handle_array(self, socket_file, system_side):
        num_elements = int(socket_file.readline().rstrip(b'\r\n'))
        # socket_file.readline().rstrip(b'\r\n')
        # num_elements = int(socket_file)
        return [self.handle_request(socket_file, system_side) for _ in range(num_elements)]
    
    def handle_dict(self, socket_file, system_side):
        # since each kv pair consists of tewo elements, it reads numItems * 2
        num_items = int(socket_file.readline().rstrip(b'\r\n'))
        elements = [self.handle_request(socket_file, system_side)
                    for _ in range(num_items * 2)]
        return dict(zip(elements[::2], elements[1::2]))
        # [::2] takes every second element starting from the first element
        # [1::2] takes every second element starting from the second element
        # zip() pairs each key with corresponding value
        # dict() converts the list of pairs into a dictionary

    def write_response(self, socket_file, data): # serialize the response data and send it to the client
        buf = BytesIO() #creates in memory buffer, allowing to treat bytes data as file-like-object
        self._write(buf, data) # serializes data into a byte stream
        # writing data to buf moves pointer of buf at the end 
        buf.seek(0) # moves the internal pointer of buf back to the beginning
        socket_file.write(buf.getvalue()) # retrieves content of buf, writes it to socket_file
        # .write sends bytes over to the client
        socket_file.flush() # ensures all data in socket_file is sent out 

    def _write(self, buf, data):
        if isinstance(data, str): # if data is string, encode to bytes
            data = data.encode('utf-8')

        if isinstance(data, bytes):
            buf.write(b'$%d\r\n%s\r\n' % (len(data), data))
        elif isinstance(data, int):
            buf.write(b':%d\r\n' % data)
        elif isinstance(data, Error):
            buf.write(b'-%s\r\n' % error.message.encode('utf-8'))
        elif isinstance(data, (list, tuple)): # if data is a list or tuple
            buf.write(b'*%d\r\n' % len(data))
            for item in data:
                self._write(buf, item)
        elif isinstance(data, dict): # if data is dict
            buf.write(b'%%%d\r\n' % len(data))
            for key in data:
                self._write(buf, key)
                self._write(buf, data[key])
        # recursively calls for each key and value
        elif data is None:
            buf.write(b'$-1\r\n')
        else:
            raise CommandError('unrecognized type: %s' % type(data))


class Server(object): # manages client connections
    def __init__(self, host='127.0.0.1', port=31337, max_clients=64):
        self._pool = Pool(max_clients) # fixed number of greenlets up to max_clients
        self._server = StreamServer( # instance(_server) listens on specified host and port
            (host, port),
            self.connection_handler,
            spawn=self._pool)

        self._protocol = ProtocolHandler() # instance(_protocol) to handle protocol
        self._kv = {} # dictionary to store key valur pairs

        self._commands = self.get_commands()

    def get_commands(self):
        return {
            b'GET': self.get,
            b'SET': self.set,
            b'DELETE': self.delete,
            b'FLUSH': self.flush,
            b'MGET': self.mget,
            b'MSET': self.mset
        }

    def connection_handler(self, conn, address):
        logger.info('Connection received: %s:%s' % address)
        # Convert "conn" (a socket object) into a file-like object.
        socket_file = conn.makefile('rwb') #converts socket conn into file like object to read / write binary data (rwb)

        # Process client requests until client disconnects.
        while True:
            try:
                data = self._protocol.handle_request(socket_file, server_side) # parses client request
            except Disconnect:
                logger.info('Client went away: %s:%s' % address) # breaks loop when client disconnects
                break

            try:
                # print(data.decode('ascii'))
                resp = self.get_response(data) # processes request, returns response
            except CommandError as exc:
                logger.exception('Command error') # creates an error response if there's an issue w/ command
                resp = Error(exc.args[0])

            self._protocol.write_response(socket_file, resp)

    def run(self):
        # starts the server which will now liseten for incoming connections and handle them 
        self._server.serve_forever()

    def get_response(self, data):
        # here we'll actually unpack the data sent by the client, execute the command they specified and pass back the return value
        if not isinstance(data, list): # if data is not a list
            try:
                data = data.split() # turn to list
            except:
                raise CommandError('Request must be list or simple string.')

        if not data: # if not command was provided
            raise CommandError('Missing command')

        command = data[0].upper() # extract a command, converted to ensure it matches dict keys
        if command not in self._commands:
            raise CommandError('Unrecognized command: %s' % command.decode('ascii'))
        else:
            logger.debug('Received %s', command.decode('ascii'))

        return self._commands[command](*data[1:]) # corresponding method is called, everything after command is passed 

    def get(self, key): # retrieves the value associated with the given 'key' from the key-value store
        return self._kv.get(key) # at self._kv

    def set(self, key, value): # updates the value at key
        self._kv[key] = value
        return 1

    def delete(self, key): # if key in self._kv, delete key, return 1
        if key in self._kv:
            del self._kv[key]
            return 1
        return 0 # if not, return 0

    def flush(self):
        kvlen = len(self._kv) - 1
        self._kv.clear() # clears the dictionary
        return kvlen

    def mget(self, *keys): # get multiple values associated with multiple keys
        return [self._kv.get(key) for key in keys]

    def mset(self, *items): # sets multiple values
        data = list(zip(items[::2], items[1::2]))
        for key, value in data:
            # print(key, value)
            self._kv[key] = value
        # print(len(data))
        return len(data)


class Client(object):
    def __init__(self, host='127.0.0.1', port=31337):
        self._protocol = ProtocolHandler() # inits an instance of protocalHandler
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # Creates a new socket using the IPv4 address family (AF_INET) and the TCP protocol (SOCK_STREAM).
        self._socket.connect((host, port))
        self._fh = self._socket.makefile('rwb') # converts socket into a file-like object for reading and writing

    def execute(self, *args): # sends command to server, processes response
        self._protocol.write_response(self._fh, args) # serializes args, writes them to server via 'self._fh'
        resp = self._protocol.handle_request(self._fh, client_side) # reads the response from the server and deserializes it 
        # print(resp)
        if isinstance(resp, Error):
            raise CommandError(resp.message)
        return resp

    def get(self, key):
        return self.execute('GET', key)

    def set(self, key, value):
        return self.execute('SET', key, value)

    def delete(self, key):
        return self.execute('DELETE', key)

    def flush(self):
        return self.execute('FLUSH')

    def mget(self, *keys):
        return self.execute('MGET', *keys)

    def mset(self, *items):
        return self.execute('MSET', *items)


if __name__ == '__main__': # line ensures the following code runs if the script is executed directly 
    from gevent import monkey; monkey.patch_all()
    logger.addHandler(logging.StreamHandler())
    logger.setLevel(logging.DEBUG)
    Server().run() # this instantiates the 'server' class ancd calls it's 'run()' method, which starts the server. 

# Patches the standard library for asynchronous operation with gevent.
# Sets up logging to output detailed debug information to the console.
# Starts the custom server, which will handle incoming connections in a non-blocking manner, making it capable of serving multiple clients concurrently.

# ____________________________________________________________________________
# Add more commands!
# Use the protocol handler to implement an append-only command log
# More robust error handling
# Allow client to close connection and re-connect
# Logging
# Re-write to use the standard library's SocketServer and ThreadingMixin
