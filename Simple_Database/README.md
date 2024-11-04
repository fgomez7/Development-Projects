# Simple Database

This is a simple database created in C. It uses a b-tree with a pointer arithmetic implementation to efficiently traverse through the b-tree. This implementation is used to store user information on a disk. So when the program is closed and when the program is opened again, the information inputed prior to ending the session will still be accessed.

## Argument Instructions
1. `./main.c test.db` - When starting the application, you must include a filename. 
2. `select` - will print all the information that is stored in the disk
3. `insert 35 user35 person35@3xample.com` - To insert information, provide the argument insert along with an insert id, user name and email.
4. `.btree` - will print all of the information under a btree format.
5. `.exit` - will save all inserted information onto a disk and close the executable
6. `gcc main.c -o main` - To compile
7. `bundle exec rspec` - if you'd like to make scripts, the command and a script is being provided for testing purposes given that rspec is already installed 