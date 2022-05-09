import puppeteer from "puppeteer";
import readXlsxFile from "read-excel-file/node";
import * as fs from "fs";
import * as Client from "ftp";
import fetch from "node-fetch";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MINI_PATH = `${__dirname}/media/gallery/mini`;
const NORMAL_PATH = `${__dirname}/media/gallery/normal`;
const BIG_PATH = `${__dirname}/media/gallery/big`;
const ORG_PATH = `${__dirname}/media/gallery/org`;

const getLargeUrl = (id) =>
  `https://www.astenrealty.com/system/photos/large/${id}`;

readXlsxFile("./data.xlsx").then(async (rows) => {
  rows.shift();

  if (!process.env.USE_CACHE_FILE) {
    const allData = await getDataFromSites(rows.map((row) => row[0]));
    fs.writeFileSync("./data.json", JSON.stringify(allData));
  }
  //
  // const client = new Client();
  // client.on("ready", () => {
  //   client.mkdir("import", () => {
  //     client.cwd("import", () => {
  //       client.put("data.json", "data.json", () => {
  //         client.end();
  //       });
  //     });
  //   });
  // });
  //
  // client.connect({
  //   host: "activcanariasproperties.com",
  //   user: "ftp@activcanariasproperties.com",
  //   password: "!pm:A979hl!p",
  // });
});

const streamPipeline = promisify(pipeline);

async function writeFilesForId(id) {
  const orgRes = await fetch(getLargeUrl(id));

  const orgFilePath = fs.createWriteStream(`${ORG_PATH}/${id}`);
  await streamPipeline(orgRes.body, orgFilePath);
  console.log(`Saved ${ORG_PATH}/${id}`);

  fs.copyFileSync(`${ORG_PATH}/${id}`, `${BIG_PATH}/${id}`);
  console.log(`Saved ${BIG_PATH}/${id}`);
  fs.copyFileSync(`${ORG_PATH}/${id}`, `${NORMAL_PATH}/${id}`);
  console.log(`Saved ${NORMAL_PATH}/${id}`);

  await sharp(`${ORG_PATH}/${id}`)
    .resize(700)
    .jpeg()
    .toFile(`${MINI_PATH}/${id}`);
  console.log(`Saved ${MINI_PATH}/${id}`);
}

async function getDataFromSites(references) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const data = [];

  for await (const reference of references) {
    try {
      await page.goto(`https://www.astenrealty.com/properties/${reference}`, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForSelector(
        ".property__list.property__list--code .property__list__item__value",
        { timeout: 10000 }
      );

      const pageData = await page.evaluate(async () => {
        const data = {};

        data.ref =
          document.querySelector(
            ".property__list.property__list--code .property__list__item__value"
          )?.textContent || "N/A";

        const mainProperties = document.querySelectorAll(
          ".property__list.property__list--main .property__list__item"
        );

        const detailsProperties = document.querySelectorAll(
          ".property__list:nth-of-type(3) .property__list__item"
        );

        const getAllProperties = () =>
          [...detailsProperties]
            .slice(0, detailsProperties.length / 2)
            .map((item) => ({
              key: item.querySelector(".property__list__item__key").textContent,
              value: item.querySelector(".property__list__item__value")
                .textContent,
            }));

        const getProperty = (properties, itemKey) =>
          [...properties].filter((item) => {
            const key = item.querySelector(
              ".property__list__item__key"
            )?.textContent;

            return itemKey.toLowerCase() === key.toLowerCase();
          })[0];
        const getValueFromProperty = (property) =>
          property.querySelector(".property__list__item__value").textContent;

        const location = getValueFromProperty(
          getProperty(mainProperties, "Location")
        );
        const propertyType = getValueFromProperty(
          getProperty(mainProperties, "Property type")
        );

        data.name = { en: `${propertyType} in ${location}` };
        data.location = location;
        data.propertyType = propertyType;

        document
          .querySelectorAll(".property__main__video iframe")
          .forEach((video) => {
            if (video.src.includes("youtube")) {
              data.videoLink = video.src;
            }
          });

        data.description = {
          en: document.querySelector(".property__main__description .text")
            .innerHTML,
        };

        data.price = Number(
          document
            .querySelector(".sale")
            .textContent.replace("€", "")
            .replace(/\s/g, "")
        );
        const priceBefore = Number(
          document
            .querySelector(".sale.old")
            ?.textContent.replace("€", "")
            .replace(/\s/g, "")
        );

        if (!isNaN(priceBefore)) {
          data.priceBefore = priceBefore;
        }

        const bedrooms = getProperty(detailsProperties, "Bedrooms");
        if (bedrooms) {
          data.bedrooms = Number(getValueFromProperty(bedrooms));
        }

        const bathrooms = getProperty(detailsProperties, "Bathrooms");
        if (bathrooms) {
          data.bathrooms = Number(getValueFromProperty(bathrooms));
        }

        const area = getProperty(detailsProperties, "Total area");
        if (area) {
          data.area = Number(
            getValueFromProperty(area).replace("m2", "").replace(/\s/g, "")
          );
        }

        data.allProperties = getAllProperties();
        // https://www.astenrealty.com/system/photos/normal/214599.jpg?1617800425
        const galleryItems = document.querySelectorAll(
          ".property__main__photos .pure-u-1-4 .property__main__photos__item"
        );

        const photoIds = [];
        [...galleryItems].forEach((item) => {
          const regex = /large\/(.*?)\?/g;

          const id = item.href
            .match(regex)[0]
            .replace("large/", "")
            .replace("?", "");
          photoIds.push(id);
        });
        data.gallery = photoIds;

        return data;
      });

      data.push(pageData);
    } catch (e) {
      data.push({ reference, error: "Not found" });
    }
  }

  await browser.close();

  fs.mkdir(MINI_PATH, { recursive: true }, () => {});
  fs.mkdir(NORMAL_PATH, { recursive: true }, () => {});
  fs.mkdir(BIG_PATH, { recursive: true }, () => {});
  fs.mkdir(ORG_PATH, { recursive: true }, () => {});

  for await (const realEstate of data) {
    if (realEstate.error) {
      continue;
    }

    for await (const id of realEstate.gallery) {
      await writeFilesForId(id);
    }
  }

  return data;
}
