import { describe, expect, it } from "vitest"
import { createFormsExtractor } from "../../src/extractors/forms.js"
import { run, valuesOf } from "./harness.js"

const extractor = createFormsExtractor()

const schemas = (code: string) => valuesOf(run([extractor], code), "formSchemas")
const fields = (code: string) => valuesOf(run([extractor], code), "formFields")

describe("forms — resolver detection, binding-aware, NEGATIVE direction", () => {
  it("ignores a local function named zodResolver", () => {
    const code = ["function zodResolver(schema) { return schema }", "zodResolver(orderSchema)"].join("\n")
    expect(schemas(code)).toEqual([])
  })

  it("ignores zodResolver imported from an unrelated module", () => {
    const code = ["import { zodResolver } from 'my-own-resolvers'", "zodResolver(orderSchema)"].join("\n")
    expect(schemas(code)).toEqual([])
  })
})

describe("forms — resolver detection, POSITIVE direction", () => {
  it("finds an aliased zodResolver import and resolves the schema identifier", () => {
    const code = [
      "import { zodResolver as zr } from '@hookform/resolvers/zod'",
      "useForm({ resolver: zr(orderSchema) })",
    ].join("\n")

    expect(schemas(code)).toEqual(["orderSchema"])
  })

  it("finds yupResolver and valibotResolver too", () => {
    expect(
      schemas(
        ["import { yupResolver } from '@hookform/resolvers/yup'", "yupResolver(orderSchema)"].join("\n"),
      ),
    ).toEqual(["orderSchema"])

    expect(
      schemas(
        ["import { valibotResolver } from '@hookform/resolvers/valibot'", "valibotResolver(orderSchema)"].join(
          "\n",
        ),
      ),
    ).toEqual(["orderSchema"])
  })

  it("deduplicates the same schema", () => {
    const code = [
      "import { zodResolver } from '@hookform/resolvers/zod'",
      "zodResolver(orderSchema)",
      "zodResolver(orderSchema)",
    ].join("\n")

    expect(schemas(code)).toEqual(["orderSchema"])
  })
})

describe("forms — field-name collection, configurable tag pattern", () => {
  it("collects the name attribute off a *Field component", () => {
    expect(fields('<TextField name="clientName" />')).toEqual(["clientName"])
  })

  it("collects the name attribute off Controller", () => {
    expect(fields('<Controller name="orderId" render={render} />')).toEqual(["orderId"])
  })

  it("ignores a tag that does not match the field pattern", () => {
    expect(fields('<Fieldset name="clientName" />')).toEqual([])
  })

  it("ignores a *Field tag with no name attribute", () => {
    expect(fields("<TextField />")).toEqual([])
  })

  it("respects a custom field tag pattern", () => {
    const custom = createFormsExtractor({ fieldTagPattern: /^Input$/ })
    expect(valuesOf(run([custom], '<Input name="email" />'), "formFields")).toEqual(["email"])
    expect(valuesOf(run([custom], '<TextField name="email" />'), "formFields")).toEqual([])
  })
})

describe("forms — formik", () => {
  it("reads useFormik initialValues keys as fields and a validationSchema identifier", () => {
    const code = [
      "import { useFormik } from 'formik'",
      "const form = useFormik({ initialValues: { email: '', 'first-name': '', age }, validationSchema: signupSchema, onSubmit })",
    ].join("\n")

    expect(schemas(code)).toEqual(["signupSchema"])
    expect(fields(code)).toEqual(["email", "first-name", "age"])
  })

  it("reads <Formik initialValues validationSchema> and unwraps toFormikValidationSchema", () => {
    const code = [
      "import { Formik, Field } from 'formik'",
      "import { toFormikValidationSchema } from 'zod-formik-adapter'",
      "const a = <Formik initialValues={{ email: '' }} validationSchema={toFormikValidationSchema(loginSchema)} onSubmit={f}><Field name='password' /></Formik>",
    ].join("\n")

    expect(schemas(code)).toEqual(["loginSchema"])
    expect(fields(code)).toEqual(["email", "password"])
  })

  it("reads useField with a literal name", () => {
    expect(fields("import { useField } from 'formik'\nconst [field] = useField('zip')")).toEqual(["zip"])
  })

  it("ignores an inline schema expression and a Formik tag from elsewhere", () => {
    expect(schemas("import { useFormik } from 'formik'\nuseFormik({ validationSchema: Yup.object({}) })")).toEqual([])
    expect(fields("import { Formik } from './Formik'\nconst a = <Formik initialValues={{ email: '' }} />")).toEqual([])
  })
})

describe("forms — react-final-form", () => {
  it("reads <Form initialValues> keys and useField", () => {
    const code = [
      "import { Form, useField } from 'react-final-form'",
      "const a = <Form initialValues={{ city: '' }} onSubmit={f} render={r} />",
      "useField('street')",
    ].join("\n")
    expect(fields(code)).toEqual(["city", "street"])
  })

  it("does not treat a Form tag from another library as final-form", () => {
    expect(fields("import { Form } from 'antd'\nconst a = <Form initialValues={{ city: '' }} />")).toEqual([])
  })
})

describe("forms — a validator alone is never a form", () => {
  it("records no schema for a zod schema that no form library consumes", () => {
    const code = ["import { z } from 'zod'", "export const orderSchema = z.object({ id: z.string() })", "orderSchema.parse(body)"].join(
      "\n",
    )
    expect(schemas(code)).toEqual([])
    expect(fields(code)).toEqual([])
  })
})
