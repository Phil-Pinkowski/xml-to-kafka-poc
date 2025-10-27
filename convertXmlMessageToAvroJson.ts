import avsc from 'avsc';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import { exit } from 'process';

const filePath = process.argv[2];

// get the message to process from the passed argument
// Some of the example attribute identifier come with double quotes we need to fix that
const xml = fs.readFileSync(filePath, 'utf8').replace(/(\w+)=""([^"]+)""/g, '$1="$2"');

// Pull out top level XML object name from the message - this is the schema name
const schemaName = /<(?:\w+:)?(\w+)/.exec(xml)?.[1];

// fetch the schema
const rawSchema = JSON.parse(fs.readFileSync(`./schemas/AVRO/${schemaName}.avsc.json`, 'utf8'));

// Convert to/parse as Avro schema
const schema = avsc.Type.forSchema(rawSchema as any);

// Pull out which fields across the schema are arrays (needed for the parser below)
const arrayItems = getArrayFieldsFromSchema(rawSchema);

// setup XML parser to parse to JSON
const parser = new XMLParser({
  ignoreDeclaration: true,
  removeNSPrefix: true,
  textNodeName: 'content',
  ignoreAttributes: false,
  attributeNamePrefix: '',
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
const dataForAvro = {
  // FIXME: hardcoded metadata for POC
  metadata: {
    eventId: 'test',
    traceToken: 'test',
    createdAt: Date.now(),
  },
  ...json[schemaName!],
};

// Validate the JSON against the schema to get better error messages
const valid = schema.isValid(dataForAvro, {
  errorHook: (path, val, type) => {
    console.error(`Validation Error:`);
    console.error(`  Path: ${path.join('.')}`);
    console.error(`  Value: ${JSON.stringify(val, null, 2)}`);
    console.error(`  Expected Type: ${type}`);
  },
});

if (!valid) {
  console.error('\nSchema validation failed. Exiting.');
  exit(1);
}

const avroJson = schema.toString(dataForAvro);

// log out for now
const formattedOutput = JSON.stringify(JSON.parse(avroJson), null, 3);

fs.writeFileSync(`./output/${schemaName}.json`, formattedOutput);

// TODO for a real gateway/inbound pipeline
// - decide on Kafka topic name (probably just industry_<schema name>_v1)
// - publish to Kafka
// - tidy everything up - it's a POC so is rough and ready :)

// util function: return which fields from the Avro schema have type "array"
function getArrayFieldsFromSchema(jsonSchema: any): string[] {
  const results: string[] = [];

  function traverse(schema: any) {
    if (!schema) {
      return;
    }

    if (schema.type === 'record' && schema.fields) {
      for (const field of schema.fields) {
        let fieldType = field.type;
        // Handle nullable types
        if (Array.isArray(fieldType)) {
          fieldType = fieldType.find((t) => t !== 'null');
        }

        if (fieldType && fieldType.type === 'array') {
          results.push(field.name);
          // Recurse into array items to find nested arrays
          if (fieldType.items) {
            traverse(fieldType.items);
          }
        } else if (fieldType && fieldType.type === 'record') {
          // Recurse into nested records
          traverse(fieldType);
        }
      }
    }
    // This handles the case where the item of an array is a record
    else if (schema.items && schema.items.type === 'record') {
      traverse(schema.items);
    }
  }

  traverse(jsonSchema);
  return results;
}
