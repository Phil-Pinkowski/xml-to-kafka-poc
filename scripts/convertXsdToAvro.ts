import * as fs from 'fs';
import * as path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import { v4 as uuidv4 } from 'uuid';

// --- Define Avro types for clarity ---

type AvroPrimitive = 'string' | 'long' | 'boolean' | 'double' | 'float' | 'null';

type AvroLogicalType = {
  type: AvroPrimitive;
  logicalType: string;
}

type AvroField = {
  name: string;
  type: AvroType;
  default?: any;
}

type AvroRecord = {
  type: 'record';
  name: string;
  doc?: string;
  fields: AvroField[];
  namespace?: string;
}

type AvroEnum = {
  type: 'enum';
  name: string;
  symbols: string[];
}

type AvroArray = {
  type: 'array';
  items: AvroType;
}

// AvroType can be a primitive, a complex type, a reference (string), or a union
type AvroComplexType = AvroRecord | AvroEnum | AvroArray | AvroLogicalType;
type AvroType = AvroPrimitive | AvroComplexType | string | (AvroPrimitive | AvroComplexType | string | 'null')[];

// The root schema is always a record in this script
type AvroSchema = AvroRecord;

// --- Main Conversion Function ---

/**
 * Converts an XSD file to an Avro schema, handling complex types and references.
 */
function convertXsdToAvro(xsdPath: string, avroDir: string): void {
  const ns = 'http://www.w3.org/2001/XMLSchema';

  // --- DOM Traversal Helpers ---

  /**
   * Finds all direct child elements matching a tag name and namespace.
   */
  const findChildren = (element: Element, tagName: string): Element[] => {
    return Array.from(element.childNodes).filter(
      (n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === tagName
    ) as Element[];
  };

  /**
   * Finds the first direct child element matching a tag name and namespace.
   */
  const findChild = (element: Element, tagName: string): Element | null => {
    const children = findChildren(element, tagName);
    return children.length > 0 ? children[0] : null;
  };

  // --- Start Conversion ---

  try {
    const xsdContent = fs.readFileSync(xsdPath, 'utf-8');
    const parser = new DOMParser();
    const doc = parser.parseFromString(xsdContent, 'application/xml');
    const root = doc.documentElement;

    if (!root) {
      throw new Error('Could not parse XSD file, no root element found.');
    }

    const definedTypes = new Set<string>();
    const definedSimpleEnums = new Set<string>();

    // Pre-map all named complex and simple types defined at the root
    const namedComplexTypes = new Map<string, Element>();
    findChildren(root, 'complexType').forEach((node) => {
      const name = node.getAttribute('name');
      if (name) {
        namedComplexTypes.set(name, node);
      }
    });

    const namedSimpleTypes = new Map<string, Element>();
    findChildren(root, 'simpleType').forEach((node) => {
      const name = node.getAttribute('name');
      if (name) {
        namedSimpleTypes.set(name, node);
      }
    });

    // --- Nested Parser Functions ---

    const getPrimitiveAvroType = (xsdType: string): AvroPrimitive => {
      const type = xsdType.split(':').pop() || '';
      switch (type) {
        case 'string':
        case 'token':
        case 'duration':
        case 'gMonth':
        case 'gYear':
        case 'dateTime':
        case 'date':
        case 'time':
        case 'decimal':
        case 'short':
        case 'byte':
          return 'string';
        // TODO: Try and convert all "integer" types to long but in the future they might have to be "string"
        case 'int':
        case 'integer':
        case 'positiveInteger':
        case 'nonNegativeInteger':
        case 'unsignedInt':
        case 'long':
          return 'long';
        case 'boolean':
          return 'boolean';
        case 'double':
          return 'double';
        case 'float':
          return 'float';
        default:
          return 'string';
      }
    };

    const getAllEnumerations = (
      restrictionNode: Element | null,
      currentSimpleTypeName: string | null = null
    ): Set<string> => {
      const enums = new Set<string>();
      if (!restrictionNode) {
        return enums;
      }

      findChildren(restrictionNode, 'enumeration').forEach((enumNode) => {
        const value = enumNode.getAttribute('value');
        if (value) {
          enums.add(value);
        }
      });

      const baseTypeAttr = restrictionNode.getAttribute('base');
      if (baseTypeAttr) {
        const baseTypeName = baseTypeAttr.split(':').pop()!;
        if (
          namedSimpleTypes.has(baseTypeName) &&
          baseTypeName !== currentSimpleTypeName
        ) {
          const baseSimpleTypeNode = namedSimpleTypes.get(baseTypeName)!;
          const baseRestriction = findChild(baseSimpleTypeNode, 'restriction');
          if (baseRestriction) {
            getAllEnumerations(baseRestriction, baseTypeName).forEach((e) =>
              enums.add(e)
            );
          }
        }
      }
      return enums;
    };

    /**
     * Parses a simpleType, primarily for its base type or enumerations.
     */
    const parseSimpleType = (
      simpleTypeNode: Element,
      nameHint: string | null = null
    ): AvroType => {
      const restriction = findChild(simpleTypeNode, 'restriction');
      if (restriction) {
        const patternNode = findChild(restriction, 'pattern');
        if (patternNode?.getAttribute('value') === 'true|false') {
          return 'boolean';
        }

        const allEnums = Array.from(
          getAllEnumerations(restriction, simpleTypeNode.getAttribute('name'))
        ).sort();

        if (allEnums.length > 0) {
          // Avro symbols must match [A-Za-z_][A-Za-z0-9_]*
          const isValidAvroSymbol = (s: string): boolean => {
            return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
          };

          // If ANY symbol is invalid (e.g., "260"), treat as string.
          if (!allEnums.every(isValidAvroSymbol)) {
            return 'string';
          }

          let enumNameCandidate = simpleTypeNode.getAttribute('name');
          if (!enumNameCandidate && nameHint) {
            enumNameCandidate = nameHint + 'Enum';
          } else if (!enumNameCandidate) {
            enumNameCandidate =
              'GeneratedEnum' + uuidv4().replace(/-/g, '');
          }

          enumNameCandidate = enumNameCandidate!.replace(/[^a-zA-Z0-9_]/g, '');
          if (
            !enumNameCandidate ||
            !/^[A-Za-z_]/.test(enumNameCandidate[0])
          ) {
            enumNameCandidate = '_' + enumNameCandidate;
          }

          if (definedSimpleEnums.has(enumNameCandidate)) {
            return enumNameCandidate; // Return just the name (string) for reuse
          }

          definedSimpleEnums.add(enumNameCandidate);
          return {
            type: 'enum',
            name: enumNameCandidate,
            symbols: allEnums,
          };
        }

        const baseAttr = restriction.getAttribute('base');
        if (baseAttr) {
          return getPrimitiveAvroType(baseAttr);
        }
      }
      return 'string';
    };

    const parseComplexType = (
      complexTypeNode: Element,
      recordName: string
    ): AvroType => {
      if (definedTypes.has(recordName)) {
        return recordName;
      }
      definedTypes.add(recordName);

      const recordSchema: AvroRecord = {
        type: 'record',
        name: recordName,
        fields: [],
      };
      let fields: AvroField[] = [];

      const simpleContent = findChild(complexTypeNode, 'simpleContent');
      if (simpleContent) {
        const extension = findChild(simpleContent, 'extension');
        const restriction = findChild(simpleContent, 'restriction');

        let baseTypeName: string | null = null;
        let attributesNode: Element | null = null;

        if (extension) {
          baseTypeName = extension.getAttribute('base');
          attributesNode = extension;
        } else if (restriction) {
          baseTypeName = restriction.getAttribute('base');
          attributesNode = restriction;
        }

        if (baseTypeName) {
          const baseName = baseTypeName.split(':').pop()!;
          if (namedComplexTypes.has(baseName)) {
            const baseSchema = parseComplexType(
              namedComplexTypes.get(baseName)!,
              baseName
            );
            if (typeof baseSchema === 'object' && baseSchema.type === 'record') {
              fields = fields.concat(baseSchema.fields || []);
            }
          } else if (namedSimpleTypes.has(baseName)) {
            fields.push({
              name: 'content',
              type: parseSimpleType(namedSimpleTypes.get(baseName)!, baseName),
            });
          } else {
            fields.push({
              name: 'content',
              type: getPrimitiveAvroType(baseName),
            });
          }
        }

        if (attributesNode) {
          findChildren(attributesNode, 'attribute').forEach((attr) => {
            const attrName = attr.getAttribute('name')!;
            const attrTypeAttr = attr.getAttribute('type');
            let attrType: AvroType = 'string'; // Default

            if (attrTypeAttr) {
              const typeName = attrTypeAttr.split(':').pop()!;
              if (namedSimpleTypes.has(typeName)) {
                attrType = parseSimpleType(
                  namedSimpleTypes.get(typeName)!,
                  typeName
                );
              } else {
                attrType = getPrimitiveAvroType(attrTypeAttr);
              }
            } else {
              const inlineSimpleType = findChild(attr, 'simpleType');
              if (inlineSimpleType) {
                attrType = parseSimpleType(inlineSimpleType, attrName);
              }
            }

            const fieldDef: AvroField = { name: attrName, type: attrType };
            if (attr.getAttribute('use') === 'optional') {
              fieldDef.type = ['null', attrType];
              fieldDef.default = null;
            }
            fields.push(fieldDef);
          });
        }
      } else {
        const sequence = findChild(complexTypeNode, 'sequence');
        if (sequence) {
          fields = fields.concat(processCompositorElements(sequence));
        }

        const choice = findChild(complexTypeNode, 'choice');
        if (choice) {
          fields = fields.concat(processCompositorElements(choice, true));
        }

        findChildren(complexTypeNode, 'attribute').forEach((attr) => {
          const attrName = attr.getAttribute('name')!;
          const attrTypeAttr = attr.getAttribute('type');
          let attrType: AvroType = 'string'; // Default

          if (attrTypeAttr) {
            const typeName = attrTypeAttr.split(':').pop()!;
            if (namedSimpleTypes.has(typeName)) {
              attrType = parseSimpleType(
                namedSimpleTypes.get(typeName)!,
                typeName
              );
            } else {
              attrType = getPrimitiveAvroType(attrTypeAttr);
            }
          } else {
            const inlineSimpleType = findChild(attr, 'simpleType');
            if (inlineSimpleType) {
              attrType = parseSimpleType(inlineSimpleType, attrName);
            }
          }

          const fieldDef: AvroField = { name: attrName, type: attrType };
          if (attr.getAttribute('use') === 'optional') {
            fieldDef.type = ['null', attrType];
            fieldDef.default = null;
          }
          fields.push(fieldDef);
        });
      }

      recordSchema.fields = fields;
      return recordSchema;
    };

    const processCompositorElements = (
      compositorNode: Element,
      isChoice: boolean = false
    ): AvroField[] => {
      const fields: AvroField[] = [];
      findChildren(compositorNode, 'element').forEach((elementNode) => {
        const fieldName = elementNode.getAttribute('name')!;
        const minOccurs = elementNode.getAttribute('minOccurs') || '1';
        const maxOccurs = elementNode.getAttribute('maxOccurs') || '1';

        const isOptional = minOccurs === '0' || isChoice;
        const isArray = maxOccurs === 'unbounded';

        let fieldType: AvroType | null = null;
        const typeAttr = elementNode.getAttribute('type');

        if (typeAttr) {
          const typeName = typeAttr.split(':').pop()!;
          if (namedComplexTypes.has(typeName)) {
            fieldType = parseComplexType(
              namedComplexTypes.get(typeName)!,
              typeName
            );
          } else if (namedSimpleTypes.has(typeName)) {
            fieldType = parseSimpleType(
              namedSimpleTypes.get(typeName)!,
              typeName
            );
          } else {
            fieldType = getPrimitiveAvroType(typeAttr);
          }
        } else {
          const complexTypeNode = findChild(elementNode, 'complexType');
          if (complexTypeNode) {
            fieldType = parseComplexType(complexTypeNode, fieldName + 'Type');
          } else {
            const simpleTypeNode = findChild(elementNode, 'simpleType');
            if (simpleTypeNode) {
              fieldType = parseSimpleType(simpleTypeNode, fieldName);
            }
          }
        }

        if (fieldType === null) {
          fieldType = 'string';
        }

        let finalType: AvroType = fieldType;
        if (isArray) {
          finalType = { type: 'array', items: finalType };
        }

        const fieldDef: AvroField = { name: fieldName, type: finalType };
        if (isOptional && finalType !== 'null') {
          fieldDef.type = ['null', finalType];
          fieldDef.default = null;
        } else {
          fieldDef.type = finalType;
        }

        fields.push(fieldDef);
      });
      return fields;
    };

    // --- Main Conversion Logic ---

    const avroSchema: AvroSchema = {
      type: 'record',
      name: '',
      doc: '',
      fields: [],
    };

    const version = root.getAttribute('version') || '';
    if (version) {
      avroSchema.doc = `Version ${version}`;
    }

    const mainElement = findChild(root, 'element');
    if (!mainElement) {
      throw new Error('No root element found in XSD');
    }

    avroSchema.name = mainElement.getAttribute('name')!;

    const mainElementTypeName = mainElement.getAttribute('type');
    if (mainElementTypeName) {
      const typeName = mainElementTypeName.split(':').pop()!;
      if (namedComplexTypes.has(typeName)) {
        const parsedSchema = parseComplexType(
          namedComplexTypes.get(typeName)!,
          typeName
        );
        if (typeof parsedSchema === 'object' && parsedSchema.type === 'record') {
          avroSchema.fields = parsedSchema.fields || [];
        }
      }
    } else {
      const complexTypeNode = findChild(mainElement, 'complexType');
      if (complexTypeNode) {
        const typeName = avroSchema.name + 'Type';
        const parsedSchema = parseComplexType(complexTypeNode, typeName);
        if (typeof parsedSchema === 'object' && parsedSchema.type === 'record') {
          avroSchema.fields = parsedSchema.fields || [];
        }
      }
    }

    const metadataField: AvroField = {
      name: 'metadata',
      type: {
        fields: [
          { name: 'eventId', type: 'string' },
          { name: 'traceToken', type: 'string' },
          {
            name: 'createdAt',
            type: {
              logicalType: 'timestamp-millis',
              type: 'long',
            },
          },
        ],
        name: 'EventMetadata',
        namespace: 'com.ovoenergy.kafka.common.event',
        type: 'record',
      },
    };

    // Add the metadata field to the beginning of the top-level fields list
    if (Array.isArray(avroSchema.fields)) {
      avroSchema.fields.unshift(metadataField);
    } else {
      avroSchema.fields = [metadataField];
    }

    // --- Write Output File ---

    const fileName = `${avroSchema.name}.avsc.json`;
    const avroFilePath = path.join(avroDir, fileName);
    fs.writeFileSync(avroFilePath, JSON.stringify(avroSchema, null, 2));

    console.log(`Successfully converted ${xsdPath} to ${avroFilePath}`);
  } catch (e: any) {
    console.error(`Error converting ${xsdPath}: ${e.message}`);
    console.error(e.stack);
  }
}

/**
 * Main function to convert all XSDs in a directory.
 */
function main(): void {
  const xsdDir = 'schemas/XSD';
  const avroDir = 'schemas/AVRO';

  if (!fs.existsSync(avroDir)) {
    fs.mkdirSync(avroDir, { recursive: true });
  }

  // Ensure XSD directory exists before reading
  if (!fs.existsSync(xsdDir)) {
    console.error(`XSD directory not found: ${xsdDir}`);
    return;
  }

  const xsdFiles = fs.readdirSync(xsdDir);
  for (const xsdFile of xsdFiles) {
    if (xsdFile.endsWith('.xsd')) {
      const xsdPath = path.join(xsdDir, xsdFile);
      convertXsdToAvro(xsdPath, avroDir);
    }
  }
}

// Run the main function
main();
