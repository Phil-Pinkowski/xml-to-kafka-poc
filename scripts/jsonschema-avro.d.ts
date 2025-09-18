declare module "jsonschema-avro" {
  const exports: {
    convert: (input: any) => Record<string, unknown>;
  };

  export = exports;
}
