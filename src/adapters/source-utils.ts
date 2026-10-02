import type ts from "typescript"
import type { Ast } from "../core/ast.js"
import type { TsNode } from "./types.js"

export type ObjectMember = {
  readonly name: string
  readonly value: TsNode
  readonly node: TsNode
}

export const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

export const objectMembers = (ast: Ast, object: ts.ObjectLiteralExpression): readonly ObjectMember[] =>
  object.properties.flatMap((property): readonly ObjectMember[] => {
    const nameNode = property.name
    if (nameNode === undefined) return []
    const name = ast.asIdentifier(nameNode)?.text ?? ast.asStringLiteralLike(nameNode)?.text ?? null
    if (name === null) return []

    let value: TsNode = nameNode
    property.forEachChild((child) => {
      value = child
    })
    return [{ name, value, node: property }]
  })
