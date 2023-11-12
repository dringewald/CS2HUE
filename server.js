// Importe le module HTTP (pour créer le serveur) et le module fs (pour travailler avec le système de fichiers).
http = require('http');
fs = require('fs');

// Définit le port et l'hôte sur lesquels le serveur écoutera.
port = 8080;
host = '127.0.0.1';

// Crée un serveur HTTP qui répond à toutes les requêtes avec une fonction de rappel.
server = http.createServer((req, res) => {

    // Vérifie si la requête est une requête POST.
    if (req.method == 'POST') {
        console.log("Handling POST request...");

        // Configure l'en-tête de la réponse avec le code de statut 200 et le type de contenu text/html.
        res.writeHead(200, {'Content-Type': 'text/html'});

        // Initialise une chaîne pour stocker les données de la requête POST.
        let body = '';

        // Écoute l'événement 'data' pour collecter les données de la requête.
        req.on('data', function (data) {
            body = data;
        });

        // Écoute l'événement 'end', qui est déclenché lorsque toutes les données ont été reçues.
        req.on('end', function () {
            // console.log("POST payload: " + body);
            // Termine la réponse avec une chaîne vide.
            // console.log(content);
            fs.writeFile('gamestate.txt', body, err => {
                if(err){
                    console.error("Error writing file: " + err);
                }
            })
            res.end( '' );
        });
    }
    // Si la requête n'est pas une requête POST.
    else {
        console.log("Request received is not POST.");

        // Configure l'en-tête de la réponse avec le code de statut 200 et le type de contenu text/html.
        res.writeHead(200, {'Content-Type': 'text/html'});

        // Crée une page HTML de réponse indiquant l'adresse et le port du serveur.
        var html = '<html><body>HTTP Server at http://' + host + ':' + port + '</body></html>';

        // Termine la réponse avec la page HTML créée.
        res.end(html);
    }

});

// Fait écouter le serveur sur le port et l'hôte spécifiés.
server.listen(port, host);

// Affiche un message dans la console indiquant que le serveur écoute.
console.log('Listening at http://' + host + ':' + port);