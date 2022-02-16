import { AssignmentExpression, BinaryExpression, CallExpression, Expression, Identifier, Literal, NodeType, UnaryExpression } from "./estree";

export function createAssignmentExpression({ left, right }: { left: Identifier | Expression; right: Expression }, range?: Number[], loc?: {start:{line:Number, column: Number}, end:{line:Number, column: Number}} ): AssignmentExpression {
  return {
    type: NodeType.AssignmentExpression,
    operator: "=",
    left,
    right,
  };
}

export function createCallExpression(callee: Expression, args: Expression[] = []): CallExpression {
  return {
    type: NodeType.CallExpression,
    callee,
    arguments: args,
  };
}

export function createIdentifier(name: string, range?: Number[], loc?: {start:{line:Number, column: Number}, end:{line:Number, column: Number}} ): Identifier {
  return {
    type: NodeType.Identifier,
    name,
    loc,
    range
  };
}

export function createIdentityComparisonExpression({ left, right }: { left: Expression; right: Expression },  range?: Number[], loc?: {start:{line:Number, column: Number}, end:{line:Number, column: Number}} ): BinaryExpression {
  return {
    type: NodeType.BinaryExpression,
    operator: "===",
    left,
    right,
    loc,
    range
  };
}

export function createLiteral(value: boolean | number): Literal {
  return {
    type: NodeType.Literal,
    raw: String(value),
    value: value,
  };
}

export function createUnaryNegationExpression(innerExpression: Expression): UnaryExpression {
  return {
    type: NodeType.UnaryExpression,
    operator: "!",
    prefix: true,
    argument: innerExpression,
  };
}
