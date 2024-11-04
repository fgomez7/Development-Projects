# MINIATURE REDIS with Python

The purpose of this project was to write a simple Redis-like database server with sockets in python. This Redis can be used as default storage engine for tracking enqueued jobs or results of finished jobs. 

Server responds to the commands: 
- GET `<key>`
- SET `<key> <value>`
- DELETE `<key>`
- FLUSH
- MGET `<key1> ... <keyn>`
- MSET `<key1> <value1> ... <keyn> <value n>`

Supports following data-types
- Strings and Binary Data
- Numbers 
- NULL
- Arrays
- Dictionaries
- Error messages

To run, on one terminal, start the server by typing `python3 ser.py`
On another terminal, you can interact with the server by enterning a python interpreter, `python3`
In the interpreter, type the next two lines. 
1. `from ser import Client`
2. `client = Client()`

It'll start a connection CLIENT to ser.py SERVER

You can now use the commands as described below. 
- `client.mset('k1', 'v1', 'k2', 'v2')` to set multiple values for multiple keys
- `client.get('k1')` to get value of key
- `client.mget('k1', 'k2')` to get multiple values of multiple keys
- `client.delete('k1')` to delete key
- `client.set('kx', {'vx': {'vy': 0, 'vz': [1, 2, 3]}})` to set a dictionary with key value pairs
- `client.flush()` to flush away all stored information in redis
