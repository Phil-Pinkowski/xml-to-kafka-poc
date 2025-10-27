#!/usr/bin/env bash

rm -rf avroSchemas
rm -rf xmlns

# Convert all XSD files in the schemas/XSD directory to TS using cxsd
for file in schemas/XSD/*.xsd; do
    cxsd "file://$file"
done

# remove namespace prefix from generated files
for file in xmlns/*.d.ts; do
    # Extract the filename after the last colon and remove any leading digits and hyphens
    newfile=$(basename "$file" | sed 's/.*:\([^:]*\)$/\1/' | sed 's/^[0-9-]*//')
    mv "$file" "xmlns/$newfile"
done

# Fix imports in generated files
for file in xmlns/*.d.ts; do
    # ignore xml-primitives.d.ts file
    if [[ "$file" == *"xml-primitives.d.ts"* ]]; then
        continue
    fi
    echo "Processing $file"
    # Remove baseType definition as it clashes with definition in primitives file
    sed -i.bak '/interface BaseType {/,/}/c\
import { BaseType } from "./xml-primitives";
' "$file"
done

# Convert all generated TS files to Avro schema using a custom script
mkdir -p avroSchemas
for file in xmlns/*.d.ts; do
    npx tsx scripts/convertTsToAvroSchema.ts "$file" > avroSchemas/$(basename "${file%.d.ts}.avsc.json") || true
done

# Cleanup temporary files
rm -rf xmlns
