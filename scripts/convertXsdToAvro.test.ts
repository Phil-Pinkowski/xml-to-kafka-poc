import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

const xsd = `
<?xml version="1.0" encoding="UTF-8" ?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
<xs:element name="shiporder">
  <xs:complexType>
    <xs:sequence>
      <xs:element name="orderperson" type="xs:string"/>
      <xs:element name="shipto">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="name" type="xs:string"/>
            <xs:element name="address" type="xs:string"/>
            <xs:element name="city" type="xs:string"/>
            <xs:element name="country" type="xs:string"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="item" maxOccurs="unbounded">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="title" type="xs:string"/>
            <xs:element name="note" type="xs:string" minOccurs="0"/>
            <xs:element name="quantity" type="xs:positiveInteger"/>
            <xs:element name="price" type="xs:decimal"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
    <xs:attribute name="orderid" type="xs:string" use="required"/>
  </xs:complexType>
</xs:element>

</xs:schema>
`;

describe('convertXsdToAvro', () => {
  afterAll(() => {
    fs.rmSync(path.resolve(__dirname, '../schemas/XSD/sample.xsd'));
    fs.rmSync(path.resolve(__dirname, '../schemas/AVRO/shiporder.avsc.json'));
  });

  it('should generate a valid Avro schema from XML input', () => {
    fs.writeFileSync(path.resolve(__dirname, '../schemas/XSD/sample.xsd'), xsd);
    execSync('npx tsx scripts/convertXsdToAvro.ts');
    const result = fs.readFileSync(
      path.resolve(__dirname, '../schemas/AVRO/shiporder.avsc.json'),
      'utf-8'
    );
    expect(result).toStrictEqual(`{
  "type": "record",
  "name": "shiporder",
  "fields": [
    {
      "name": "metadata",
      "type": {
        "fields": [
          {
            "name": "eventId",
            "type": "string"
          },
          {
            "name": "traceToken",
            "type": "string"
          },
          {
            "name": "createdAt",
            "type": {
              "logicalType": "timestamp-millis",
              "type": "long"
            }
          }
        ],
        "name": "EventMetadata",
        "namespace": "com.ovoenergy.kafka.common.event",
        "type": "record"
      }
    },
    {
      "name": "orderperson",
      "type": "string"
    },
    {
      "name": "shipto",
      "type": {
        "type": "record",
        "name": "shiptoType",
        "fields": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "address",
            "type": "string"
          },
          {
            "name": "city",
            "type": "string"
          },
          {
            "name": "country",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "item",
      "type": {
        "type": "array",
        "items": {
          "type": "record",
          "name": "itemType",
          "fields": [
            {
              "name": "title",
              "type": "string"
            },
            {
              "name": "note",
              "type": [
                "null",
                "string"
              ],
              "default": null
            },
            {
              "name": "quantity",
              "type": "string"
            },
            {
              "name": "price",
              "type": "string"
            }
          ]
        }
      }
    },
    {
      "name": "orderid",
      "type": "string"
    }
  ]
}`);
  });
});
