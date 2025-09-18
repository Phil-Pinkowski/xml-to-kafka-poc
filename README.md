# XML To Avro JSON Auto converter POC

This POC converts XML messages (with a known XSD schema) into AVRO Json messages which can be published to Kafka
It does this by:

- Fetching the (Avro) schema from the XML message using the message type (using pre-generated Avro schemas, described more below)
- Converting the XML message to JSON (using some custom rules and the schema)
- Using the Avro schema to parse this message as Avro and convert to Avro JSON

To allow us to process messages, we first automatically generate Avro schema based on the source XML XSD schemas. This is a bit of a multi-stage process but does seem to work:

- We take the XSD schema and generate a Typescript type definition using `CXSD` (yes it's old but still works)
- We take the generated type and convert this to a JSON schema using `ts-json-schema-generator`
- We take the JSON schema and use this to generate an Avro schema using `jsonschema-avro`

tl;dr: XSD -> TS types -> JSON Schema -> Avro Schema

## Running the POC

1. Ensure everything is installed (`npm i`)
2. Run the script (only needed one time) to convert all the XSD schemas to Avro `npm run convert-xml-schemas-to-avro`
3. To convert a message, run `tsx convertXmlMessageToAvroJson.ts <message to convert>.xml`
