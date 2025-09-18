import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import avsc from "avsc";

// get the message to process from the passed argument
const xml = fs.readFileSync(process.argv[2], "utf8");

// Pull out top level XML object name from the message - this is the schema name
const schemaName = /<\w+:(\w+)/.exec(xml)?.[1];

// fetch the schema
const rawSchema = JSON.parse(
  fs.readFileSync(`./avroSchemas/${schemaName}.avsc.json`, "utf8")
);

// Convert to/parse as Avro schema
const schema = avsc.Type.forSchema(rawSchema as any);

// Pull out which fields across the schema are arrays (needed for the parser below)
const arrayItems = getArrayFieldsFromSchema(rawSchema);

// setup XML parser to parse to JSON
const parser = new XMLParser({
  ignoreDeclaration: true,
  removeNSPrefix: true,
  textNodeName: "content",
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // All numbers are processed as strings
  numberParseOptions: {
    skipLike: /./,
    hex: false,
    leadingZeros: false,
  },
  // We need to tell the parser which elements (from the schema) should be an array
  isArray: (name) => {
    return arrayItems.includes(name);
  },
});

const json = parser.parse(xml);

// convert parsed JSON to Avro JSON using the schema
const avroJson = schema.toString(json);

// log out for now
console.log(avroJson);

// TODO for a real gateway/inbound pipeline
// - decide on Kafka topic name (probably just industry_<schema name>_v1)
// - publish to Kafka
// - tidy everything up - it's a POC so is rough and ready :)

// util function: return which fields from the Avro schema have type "array"
function getArrayFieldsFromSchema(jsonSchema: Record<string, any>): string[] {
  if (jsonSchema.type === "array") {
    return [jsonSchema.name, ...getArrayFieldsFromSchema(jsonSchema.items)];
  }
  if (
    Array.isArray(jsonSchema.type) &&
    jsonSchema.type.filter((t) => t !== "null")[0].type === "array"
  ) {
    return [
      jsonSchema.name,
      ...getArrayFieldsFromSchema(
        jsonSchema.type.filter((t) => t !== "null")[0].items
      ),
    ];
  }
  if (jsonSchema.type === "record") {
    return [
      ...jsonSchema.fields.map((f: any) => getArrayFieldsFromSchema(f)).flat(),
    ];
  }
  if (
    Array.isArray(jsonSchema.type) &&
    jsonSchema.type.filter((t) => t !== "null")[0].type === "record"
  ) {
    return [
      ...jsonSchema.type
        .filter((t) => t !== "null")[0]
        .fields.map((f: any) => getArrayFieldsFromSchema(f))
        .flat(),
    ];
  }
  return [];
}
