// node backend/src/scripts/getProductDB_simple.js
// Egyszerű UNAS ProductDB lekérés BEÉGETETT adatokkal.

// ── ÁLLÍTHATÓ KONSTANSOK ──────────────────────────────────────────────────────
const API_KEY      = 'adf156708336e8897b85b661bcd93294fe2eda73';   // pl. "adf156...."
const UNAS_SHOP_ID = '60391';                  // pl. "60391"
const UNAS_BASE    = 'https://api.unas.eu/shop';
const OUTFILE      = ''; // ha üres: csak kiírjuk a linket; ha pl. 'productdb.csv': le is töltjük
// ───────────────────────────────────────────────────────────────────────────────


const https = require("https");

async function login() {
  const xmlRequest = `<Params><ApiKey>${API_KEY}</ApiKey><WebshopInfo>true</WebshopInfo></Params>`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.unas.eu",
      path: "/shop/login",
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "Content-Length": Buffer.byteLength(xmlRequest),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      console.log("Login HTTP státusz:", res.statusCode);
      res.on("data", (chunk) => {
        console.log("Login chunk:", chunk.toString());
        data += chunk;
      });
      res.on("end", () => {
        console.log("Login end");
        const tokenMatch = data.match(/<Token>([^<]+)<\/Token>/);
        if (!tokenMatch) {
          return reject(new Error("Nincs token. Válasz: " + data));
        }
        resolve(tokenMatch[1]);
      });
    });

    req.on("error", (err) => {
      console.error("Login HTTPS hiba:", err);
      reject(err);
    });

    req.write(xmlRequest);
    req.end();
  });
}

async function getProductDB(token) {
  const paramsXml = `<?xml version="1.0" encoding="UTF-8"?>
  <Params>
    <Format>csv</Format>
    <Compress>no</Compress>
    <Lang>hu</Lang>
  </Params>`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.unas.eu",
      path: "/shop/getProductDB",
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(paramsXml),
      }
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const urlMatch = data.match(/<Url>([^<]+)<\/Url>/);
        if (!urlMatch) return reject(new Error("Nincs URL: " + data));
        resolve(urlMatch[1]);
      });
    });

    req.on("error", reject);
    req.write(paramsXml);
    req.end();
  });
}

(async () => {
  try {
    const token = await login();
    const url = await getProductDB(token);
    console.log("✅ Termékadatbázis letöltési link:", url);
  } catch (err) {
    console.error("Hiba:", err.message);
  }
})();