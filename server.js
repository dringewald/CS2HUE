// Import the HTTP module (to create the server) and fs module (to work with the file system).
const http = require('http');
const fs = require('fs');

// Define the port and host on which the server will listen.
const port = 8080;
const host = '127.0.0.1';

// Create an HTTP server that responds to all requests with a callback function.
const server = http.createServer((req, res) => {

    // Check if the request is a POST request.
    if (req.method == 'POST') {
        console.log("Handling POST request...");

        // Configure the response header with the status code 200 and the content type text/html.
        res.writeHead(200, {'Content-Type': 'text/html'});

        // Initialize a string to store the data from the POST request.
        let body = '';

        // Listen for the 'data' event to collect the request data.
        req.on('data', function (data) {
            body = data;
        });

        // Listen for the 'end' event, which is triggered when all data has been received.
        req.on('end', function () {
            fs.writeFile('gamestate.txt', body, err => {
                if(err){
                    console.error("Error writing file: " + err);
                }
            })
            // Finish the response with an empty string.
            res.end( '' );
        });
    }
    // If the request is not a POST request.
    else {
        console.log("Request received is not POST.");

        // Configure the response header with the status code 200 and the content type text/html.
        res.writeHead(200, {'Content-Type': 'text/html'});

        // Create an HTML response page indicating the server's address and port.
        const html = '<html><body>HTTP Server at http://' + host + ':' + port + '</body></html>';

        // Finish the response with the created HTML page.
        res.end(html);
    }

});

// Make the server listen on the specified port and host.
server.listen(port, host);

// Display a message in the console indicating that the server is listening.
console.log('Listening at http://' + host + ':' + port);
