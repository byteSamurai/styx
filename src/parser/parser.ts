import { negateTruthiness } from "./expressions/negator";
import { stringify } from "./expressions/stringifier";

import * as Passes from "./passes/index";

import * as AstPreprocessing from "./preprocessing/functionExpressionRewriter";

import { Stack } from "../collections/stack";
import IdGenerator from "../util/idGenerator";

import * as ESTree from "../estree";
import {
    ControlFlowGraph,
    EdgeType,
    FlowEdge,
    FlowFunction,
    FlowNode,
    FlowProgram,
    NodeType,
    ParserOptions
} from "./../flow";

import {
    Completion,
    EnclosingStatement,
    EnclosingStatementType,
    EnclosingTryStatement
} from "./enclosingStatement";

interface CaseBlock {
    caseClausesA: ESTree.SwitchCase[];
    defaultCase: ESTree.SwitchCase;
    caseClausesB: ESTree.SwitchCase[];
}

interface ParsingContext {
    functions: FlowFunction[];
    currentFlowGraph: ControlFlowGraph;

    enclosingStatements: Stack<EnclosingStatement>;

    createTemporaryLocalVariableName(): string;
    createNode(type?: NodeType): FlowNode;
    createFunctionId(): number;
}

interface StatementTypeToParserMap {
    [type: string]: (statement: ESTree.Statement, currentNode: FlowNode, context: ParsingContext) => Completion;
}

export function parse(program: ESTree.Program, options: ParserOptions): FlowProgram {
    let context = createParsingContext();

    let rewrittenProgram = AstPreprocessing.rewriteFunctionExpressions(program);
    let parsedProgram = parseProgram(rewrittenProgram, context);

    // Run optimization passes
    let functionFlowGraphs = context.functions.map(func => func.flowGraph);
    let flowGraphs = [parsedProgram.flowGraph, ...functionFlowGraphs];
    runOptimizationPasses(flowGraphs, options);

    return parsedProgram;
}

function createParsingContext(): ParsingContext {
    let nodeIdGenerator = IdGenerator.create();
    let functionIdGenerator = IdGenerator.create();
    let variableNameIdGenerator = IdGenerator.create();

    return {
        functions: [],
        currentFlowGraph: null,

        enclosingStatements: Stack.create<EnclosingStatement>(),

        createTemporaryLocalVariableName() {
            return "$$temp" + variableNameIdGenerator.generateId();
        },

        createNode(type = NodeType.Normal) {
            let id = nodeIdGenerator.generateId();
            return new FlowNode(id, type);
        },

        createFunctionId() {
            return functionIdGenerator.generateId();
        }
    };
}

function parseProgram(program: ESTree.Program, context: ParsingContext): FlowProgram {
    let entryNode = context.createNode(NodeType.Entry);
    let successExitNode = context.createNode(NodeType.SuccessExit);
    let errorExitNode = context.createNode(NodeType.ErrorExit);

    let programFlowGraph: ControlFlowGraph = {
        entry: entryNode,
        successExit: successExitNode,
        errorExit: errorExitNode,
        nodes: [],
        edges: []
    };

    context.currentFlowGraph = programFlowGraph;
    let completion = parseStatements(program.body, entryNode, context);

    if (completion.normal) {
        successExitNode.appendEpsilonEdgeTo(completion.normal);
    }

    return {
        flowGraph: programFlowGraph,
        functions: context.functions
    };
}

function parseStatements(statements: ESTree.Statement[], currentNode: FlowNode, context: ParsingContext): Completion {
    for (let statement of statements) {
        let completion = parseStatement(statement, currentNode, context);

        if (!completion.normal) {
            // If we encounter an abrupt completion, normal control flow is interrupted
            // and the following statements aren't executed
            return completion;
        }

        currentNode = completion.normal;
    }

    return { normal: currentNode };
}

function parseStatement(statement: ESTree.Statement, currentNode: FlowNode, context: ParsingContext): Completion {
    if (statement === null) {
        return { normal: currentNode };
    }

    let statementParsers: StatementTypeToParserMap = {
        [ESTree.NodeType.BlockStatement]: parseBlockStatement,
        [ESTree.NodeType.BreakStatement]: parseBreakStatement,
        [ESTree.NodeType.ContinueStatement]: parseContinueStatement,
        [ESTree.NodeType.DebuggerStatement]: parseDebuggerStatement,
        [ESTree.NodeType.DoWhileStatement]: parseDoWhileStatement,
        [ESTree.NodeType.EmptyStatement]: parseEmptyStatement,
        [ESTree.NodeType.ExpressionStatement]: parseExpressionStatement,
        [ESTree.NodeType.ForInStatement]: parseForInStatement,
        [ESTree.NodeType.ForStatement]: parseForStatement,
        [ESTree.NodeType.FunctionDeclaration]: parseFunctionDeclaration,
        [ESTree.NodeType.IfStatement]: parseIfStatement,
        [ESTree.NodeType.LabeledStatement]: parseLabeledStatement,
        [ESTree.NodeType.ReturnStatement]: parseReturnStatement,
        [ESTree.NodeType.SwitchStatement]: parseSwitchStatement,
        [ESTree.NodeType.ThrowStatement]: parseThrowStatement,
        [ESTree.NodeType.TryStatement]: parseTryStatement,
        [ESTree.NodeType.VariableDeclaration]: parseVariableDeclaration,
        [ESTree.NodeType.WhileStatement]: parseWhileStatement,
        [ESTree.NodeType.WithStatement]: parseWithStatement
    };

    let parsingMethod = statementParsers[statement.type];

    if (!parsingMethod) {
        throw Error(`Encountered unsupported statement type '${statement.type}'`);
    }

    return parsingMethod(statement, currentNode, context);
}

function parseFunctionDeclaration(functionDeclaration: ESTree.Function, currentNode: FlowNode, context: ParsingContext): Completion {
    let entryNode = context.createNode(NodeType.Entry);
    let successExitNode = context.createNode(NodeType.SuccessExit);
    let errorExitNode = context.createNode(NodeType.ErrorExit);

    let func: FlowFunction = {
        id: context.createFunctionId(),
        name: functionDeclaration.id.name,
        flowGraph: {
            entry: entryNode,
            successExit: successExitNode,
            errorExit: errorExitNode,
            nodes: [],
            edges: []
        }
    };

    let functionContext: ParsingContext = {
        functions: context.functions,
        currentFlowGraph: func.flowGraph,

        enclosingStatements: Stack.create<EnclosingStatement>(),

        createTemporaryLocalVariableName: context.createTemporaryLocalVariableName,
        createNode: context.createNode,
        createFunctionId: context.createFunctionId
    };

    let completion = parseBlockStatement(functionDeclaration.body, entryNode, functionContext);

    if (completion.normal) {
        // If we reached this point, the function didn't end with an explicit return statement.
        // Thus, an implicit "undefined" is returned.
        let undefinedReturnValue: ESTree.Identifier = {
            type: ESTree.NodeType.Identifier,
            name: "undefined"
        };

        let returnStatement: ESTree.ReturnStatement = {
            type: ESTree.NodeType.ReturnStatement,
            argument: undefinedReturnValue
        };

        func.flowGraph.successExit
            .appendTo(completion.normal, "return undefined", EdgeType.AbruptCompletion, returnStatement);
    }

    context.functions.push(func);

    return { normal: currentNode };
}

function parseEmptyStatement(emptyStatement: ESTree.EmptyStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    return {
        normal: context.createNode().appendTo(currentNode, "(empty)")
    };
}

function parseBlockStatement(blockStatement: ESTree.BlockStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    return parseStatements(blockStatement.body, currentNode, context);
}

function parseVariableDeclaration(declaration: ESTree.VariableDeclaration, currentNode: FlowNode, context: ParsingContext): Completion {
    for (let declarator of declaration.declarations) {
        let initString = stringify(declarator.init);
        let edgeLabel = `${declarator.id.name} = ${initString}`;
        currentNode = context.createNode().appendTo(currentNode, edgeLabel);
    }

    return { normal: currentNode };
}

function parseLabeledStatement(labeledStatement: ESTree.LabeledStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let body = labeledStatement.body;
    let label = labeledStatement.label.name;

    switch (body.type) {
        case ESTree.NodeType.BlockStatement:
        case ESTree.NodeType.IfStatement:
        case ESTree.NodeType.TryStatement:
        case ESTree.NodeType.WithStatement:
            let finalNode = context.createNode();

            let enclosingStatement: EnclosingStatement = {
                type: EnclosingStatementType.OtherStatement,
                breakTarget: finalNode,
                continueTarget: null,
                label: label
            };

            context.enclosingStatements.push(enclosingStatement);
            let bodyCompletion = parseStatement(body, currentNode, context);
            context.enclosingStatements.pop();

            if (bodyCompletion.normal) {
                finalNode.appendEpsilonEdgeTo(bodyCompletion.normal);
                return { normal: finalNode };
            }

            return bodyCompletion;

        case ESTree.NodeType.SwitchStatement:
            return parseSwitchStatement(<ESTree.SwitchStatement>body, currentNode, context, label);

        case ESTree.NodeType.WhileStatement:
            return parseWhileStatement(<ESTree.WhileStatement>body, currentNode, context, label);

        case ESTree.NodeType.DoWhileStatement:
            return parseDoWhileStatement(<ESTree.DoWhileStatement>body, currentNode, context, label);

        case ESTree.NodeType.ForStatement:
            return parseForStatement(<ESTree.ForStatement>body, currentNode, context, label);

        case ESTree.NodeType.ForInStatement:
            return parseForInStatement(<ESTree.ForInStatement>body, currentNode, context, label);

        default:
            // If we didn't encounter an enclosing statement,
            // the label is irrelevant for control flow and we thus don't track it.
            return parseStatement(body, currentNode, context);
    }
}

function parseIfStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    return ifStatement.alternate === null
        ? parseSimpleIfStatement(ifStatement, currentNode, context)
        : parseIfElseStatement(ifStatement, currentNode, context);
}

function parseSimpleIfStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let negatedTest = negateTruthiness(ifStatement.test);

    let thenLabel = stringify(ifStatement.test);
    let elseLabel = stringify(negatedTest);

    let thenNode = context.createNode()
        .appendConditionallyTo(currentNode, thenLabel, ifStatement.test);

    let thenBranchCompletion = parseStatement(ifStatement.consequent, thenNode, context);

    let finalNode = context.createNode()
        .appendConditionallyTo(currentNode, elseLabel, negatedTest);

    if (thenBranchCompletion.normal) {
        finalNode.appendEpsilonEdgeTo(thenBranchCompletion.normal);
    }

    return { normal: finalNode };
}

function parseIfElseStatement(ifStatement: ESTree.IfStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    // Then branch
    let thenLabel = stringify(ifStatement.test);
    let thenNode = context.createNode().appendConditionallyTo(currentNode, thenLabel, ifStatement.test);
    let thenBranchCompletion = parseStatement(ifStatement.consequent, thenNode, context);

    // Else branch
    let negatedTest = negateTruthiness(ifStatement.test);
    let elseLabel = stringify(negatedTest);
    let elseNode = context.createNode().appendConditionallyTo(currentNode, elseLabel, negatedTest);
    let elseBranchCompletion = parseStatement(ifStatement.alternate, elseNode, context);

    let finalNode = context.createNode();

    if (thenBranchCompletion.normal) {
        finalNode.appendEpsilonEdgeTo(thenBranchCompletion.normal);
    }

    if (elseBranchCompletion.normal) {
        finalNode.appendEpsilonEdgeTo(elseBranchCompletion.normal);
    }

    return { normal: finalNode };
}

function parseBreakStatement(breakStatement: ESTree.BreakStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let enclosingStatement = findLabeledEnclosingStatement(context, breakStatement.label);
    let finalizerCompletion = runFinalizersBeforeBreakOrContinue(currentNode, context, enclosingStatement);

    if (!finalizerCompletion.normal) {
        return finalizerCompletion;
    }

    enclosingStatement.breakTarget.appendTo(finalizerCompletion.normal, "break", EdgeType.AbruptCompletion);

    return { break: true };
}

function parseContinueStatement(continueStatement: ESTree.ContinueStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let enclosingStatement = findLabeledEnclosingStatement(context, continueStatement.label);

    if (enclosingStatement.continueTarget === null) {
        throw new Error(`Illegal continue target detected: "${continueStatement.label}" does not label an enclosing iteration statement`);
    }

    let finalizerCompletion = runFinalizersBeforeBreakOrContinue(currentNode, context, enclosingStatement);

    if (!finalizerCompletion.normal) {
        return finalizerCompletion;
    }

    enclosingStatement.continueTarget.appendTo(finalizerCompletion.normal, "continue", EdgeType.AbruptCompletion);

    return { continue: true };
}

function findLabeledEnclosingStatement(context: ParsingContext, label: ESTree.Identifier): EnclosingStatement {
    return context.enclosingStatements.find(statement => {
        if (label) {
            // If we have a truthy label, we look for a matching enclosing statement
            return statement.label === label.name;
        }

        // If we don't have a label, we look for the topmost enclosing statement
        // that is not a try statement because that would be an invalid target
        // for `break` or `continue` statements
        return statement.type !== EnclosingStatementType.TryStatement;
    });
}

function parseWithStatement(withStatement: ESTree.WithStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let stringifiedExpression = stringify(withStatement.object);
    let expressionNode = context.createNode().appendTo(currentNode, stringifiedExpression);

    return parseStatement(withStatement.body, expressionNode, context);
}

function parseSwitchStatement(switchStatement: ESTree.SwitchStatement, currentNode: FlowNode, context: ParsingContext, label?: string): Completion {
    const switchExpression = context.createTemporaryLocalVariableName();

    let stringifiedDiscriminant = stringify(switchStatement.discriminant);
    let exprRef = `${switchExpression} = ${stringifiedDiscriminant}`;
    let evaluatedDiscriminantNode = context.createNode().appendTo(currentNode, exprRef);

    let finalNode = context.createNode();

    context.enclosingStatements.push({
        type: EnclosingStatementType.OtherStatement,
        breakTarget: finalNode,
        continueTarget: null,
        label: label
    });

    let { caseClausesA, defaultCase, caseClausesB } = partitionCases(switchStatement.cases);
    let caseClauses = [...caseClausesA, ...caseClausesB];

    let stillSearchingNode = evaluatedDiscriminantNode;
    let endOfPreviousCaseBody: Completion = null;
    let firstNodeOfClauseListB: FlowNode = null;

    for (let caseClause of caseClauses) {
        let truthyCondition = {
            type: ESTree.NodeType.BinaryExpression,
            left: { type: ESTree.NodeType.Identifier, name: switchExpression },
            right: caseClause.test,
            operator: "==="
        };

        let beginOfCaseBody = context.createNode()
            .appendConditionallyTo(stillSearchingNode, stringify(truthyCondition), truthyCondition);

        if (caseClause === caseClausesB[0]) {
            firstNodeOfClauseListB = beginOfCaseBody;
        }

        if (endOfPreviousCaseBody && endOfPreviousCaseBody.normal) {
            // We reached the end of the case through normal control flow,
            // which means there was no 'break' statement at the end.
            // We therefore fall through from the previous case!
            beginOfCaseBody.appendEpsilonEdgeTo(endOfPreviousCaseBody.normal);
        }

        endOfPreviousCaseBody = parseStatements(caseClause.consequent, beginOfCaseBody, context);

        let falsyCondition = negateTruthiness(truthyCondition);
        stillSearchingNode = context.createNode()
            .appendConditionallyTo(stillSearchingNode, stringify(falsyCondition), falsyCondition);
    }

    if (endOfPreviousCaseBody && endOfPreviousCaseBody.normal) {
        // If the last case didn't end with an abrupt completion,
        // connect it to the final node and resume normal control flow.
        finalNode.appendEpsilonEdgeTo(endOfPreviousCaseBody.normal);
    }

    if (defaultCase) {
        let defaultCaseCompletion = parseStatements(defaultCase.consequent, stillSearchingNode, context);

        if (defaultCaseCompletion.normal) {
            let nodeAfterDefaultCase = firstNodeOfClauseListB || finalNode;
            nodeAfterDefaultCase.appendEpsilonEdgeTo(defaultCaseCompletion.normal);
        }
    } else {
        // If there's no default case, the switch statements isn't necessarily exhaustive.
        // Therefore, if no match is found, no clause's statement list is executed
        // and control flow resumes normally after the switch statement.
        finalNode.appendEpsilonEdgeTo(stillSearchingNode);
    }

    context.enclosingStatements.pop();

    return { normal: finalNode };
}

function partitionCases(cases: ESTree.SwitchCase[]): CaseBlock {
    let caseClausesA: ESTree.SwitchCase[] = [];
    let defaultCase: ESTree.SwitchCase = null;
    let caseClausesB: ESTree.SwitchCase[] = [];

    let isInCaseClausesA = true;

    for (let switchCase of cases) {
        if (switchCase.test === null) {
            // We found the default case
            defaultCase = switchCase;
            isInCaseClausesA = false;
        } else {
            (isInCaseClausesA ? caseClausesA : caseClausesB).push(switchCase);
        }
    }

    return { caseClausesA, defaultCase, caseClausesB };
}

function parseReturnStatement(returnStatement: ESTree.ReturnStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let argument = returnStatement.argument ? stringify(returnStatement.argument) : "undefined";
    let returnLabel = `return ${argument}`;

    let finalizerCompletion = runFinalizersBeforerReturn(currentNode, context);

    if (!finalizerCompletion.normal) {
        return finalizerCompletion;
    }

    context.currentFlowGraph.successExit
        .appendTo(finalizerCompletion.normal, returnLabel, EdgeType.AbruptCompletion, returnStatement.argument);

    return { return: true };
}

function parseThrowStatement(throwStatement: ESTree.ThrowStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let throwLabel = "throw " + stringify(throwStatement.argument);
    let enclosingStatements = context.enclosingStatements.enumerateElements();

    let foundHandler = false;

    for (let statement of enclosingStatements) {
        if (statement.type !== EnclosingStatementType.TryStatement) {
            continue;
        }

        let tryStatement = <EnclosingTryStatement>statement;

        if (tryStatement.handler && tryStatement.isCurrentlyInTryBlock) {
            let parameter = stringify(tryStatement.handler.param);
            let argument = stringify(throwStatement.argument);

            let assignmentNode = context.createNode()
                .appendTo(currentNode, `${parameter} = ${argument}`);

            tryStatement.handlerBodyEntry.appendEpsilonEdgeTo(assignmentNode);

            foundHandler = true;
            break;
        } else if (tryStatement.parseFinalizer && !tryStatement.isCurrentlyInFinalizer) {
            tryStatement.isCurrentlyInFinalizer = true;
            let finalizer = tryStatement.parseFinalizer();
            tryStatement.isCurrentlyInFinalizer = false;

            finalizer.bodyEntry.appendEpsilonEdgeTo(currentNode);

            if (finalizer.bodyCompletion.normal) {
                currentNode = finalizer.bodyCompletion.normal;
            } else {
                return finalizer.bodyCompletion;
            }
        }
    }

    if (!foundHandler) {
        context.currentFlowGraph.errorExit
            .appendTo(currentNode, throwLabel, EdgeType.AbruptCompletion, throwStatement.argument);
    }

    return { throw: true };
}

function parseTryStatement(tryStatement: ESTree.TryStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    let handler = tryStatement.handlers[0];
    let finalizer = tryStatement.finalizer;

    let parseFinalizer = () => {
        let finalizerBodyEntry = context.createNode();
        let finalizerBodyCompletion = parseBlockStatement(finalizer, finalizerBodyEntry, context);

        return {
            bodyEntry: finalizerBodyEntry,
            bodyCompletion: finalizerBodyCompletion
        };
    };

    let handlerBodyEntry = handler ? context.createNode() : null;

    let enclosingTryStatement: EnclosingTryStatement = {
        label: null,
        breakTarget: null,
        continueTarget: null,

        type: EnclosingStatementType.TryStatement,
        isCurrentlyInTryBlock: false,
        isCurrentlyInFinalizer: false,
        handler: handler,
        handlerBodyEntry,
        parseFinalizer: finalizer ? parseFinalizer : null
    };

    context.enclosingStatements.push(enclosingTryStatement);

    enclosingTryStatement.isCurrentlyInTryBlock = true;
    let tryBlockCompletion = parseBlockStatement(tryStatement.block, currentNode, context);
    enclosingTryStatement.isCurrentlyInTryBlock = false;

    let handlerBodyCompletion = handler ? parseBlockStatement(handler.body, handlerBodyEntry, context) : null;

    context.enclosingStatements.pop();

    // try/catch production
    if (handler && !finalizer) {
        let finalNode = context.createNode();

        if (tryBlockCompletion.normal) {
            finalNode.appendEpsilonEdgeTo(tryBlockCompletion.normal);
        }

        if (handlerBodyCompletion.normal) {
            finalNode.appendEpsilonEdgeTo(handlerBodyCompletion.normal);
        }

        return { normal: finalNode };
    }

    // try/finally production
    if (!handler && finalizer) {
        if (!tryBlockCompletion.normal) {
            return tryBlockCompletion;
        }

        let finalizer = parseFinalizer();
        finalizer.bodyEntry.appendEpsilonEdgeTo(tryBlockCompletion.normal);

        if (finalizer.bodyCompletion.normal) {
            let finalNode = context.createNode();
            finalNode.appendEpsilonEdgeTo(finalizer.bodyCompletion.normal);

            return { normal: finalNode };
        }

        return finalizer.bodyCompletion;
    }

    // try/catch/finally production
    let finalNode = context.createNode();

    if (tryBlockCompletion.normal) {
        let finalizer = parseFinalizer();
        finalizer.bodyEntry.appendEpsilonEdgeTo(tryBlockCompletion.normal);

        if (finalizer.bodyCompletion.normal) {
            finalNode.appendEpsilonEdgeTo(finalizer.bodyCompletion.normal);
            return { normal: finalNode };
        }

        return finalizer.bodyCompletion;
    }

    if (handlerBodyCompletion.normal) {
        let finalizer = parseFinalizer();
        finalizer.bodyEntry.appendEpsilonEdgeTo(handlerBodyCompletion.normal);

        if (finalizer.bodyCompletion.normal) {
            finalNode.appendEpsilonEdgeTo(finalizer.bodyCompletion.normal);
            return { normal: finalNode };
        }

        return finalizer.bodyCompletion;
    }

    return { normal: finalNode };
}

function parseWhileStatement(whileStatement: ESTree.WhileStatement, currentNode: FlowNode, context: ParsingContext, label?: string): Completion {
    // Truthy test (enter loop)
    let truthyCondition = whileStatement.test;
    let truthyConditionLabel = stringify(truthyCondition);

    // Falsy test (exit loop)
    let falsyCondition = negateTruthiness(truthyCondition);
    let falsyConditionLabel = stringify(falsyCondition);

    let loopBodyNode = context.createNode().appendConditionallyTo(currentNode, truthyConditionLabel, truthyCondition);
    let finalNode = context.createNode();

    context.enclosingStatements.push({
        type: EnclosingStatementType.OtherStatement,
        continueTarget: currentNode,
        breakTarget: finalNode,
        label: label
    });

    let loopBodyCompletion = parseStatement(whileStatement.body, loopBodyNode, context);

    if (loopBodyCompletion.normal) {
        currentNode.appendEpsilonEdgeTo(loopBodyCompletion.normal);
    }

    context.enclosingStatements.pop();

    finalNode
        .appendConditionallyTo(currentNode, falsyConditionLabel, falsyCondition);

    return { normal: finalNode };
}

function parseDoWhileStatement(doWhileStatement: ESTree.DoWhileStatement, currentNode: FlowNode, context: ParsingContext, label?: string): Completion {
    // Truthy test (enter loop)
    let truthyCondition = doWhileStatement.test;
    let truthyConditionLabel = stringify(truthyCondition);

    // Falsy test (exit loop)
    let falsyCondition = negateTruthiness(truthyCondition);
    let falsyConditionLabel = stringify(falsyCondition);

    let testNode = context.createNode();
    let finalNode = context.createNode();

    context.enclosingStatements.push({
        type: EnclosingStatementType.OtherStatement,
        continueTarget: testNode,
        breakTarget: finalNode,
        label: label
    });

    let loopBodyCompletion = parseStatement(doWhileStatement.body, currentNode, context);

    context.enclosingStatements.pop();

    currentNode.appendConditionallyTo(testNode, truthyConditionLabel, truthyCondition);
    finalNode.appendConditionallyTo(testNode, falsyConditionLabel, falsyCondition);

    if (loopBodyCompletion.normal) {
        testNode.appendEpsilonEdgeTo(loopBodyCompletion.normal);
    }

    return { normal: finalNode };
}

function parseForStatement(forStatement: ESTree.ForStatement, currentNode: FlowNode, context: ParsingContext, label?: string): Completion {
    // Parse initialization
    let testDecisionNode = parseStatement(forStatement.init, currentNode, context).normal;

    // Create nodes for loop cornerstones
    let beginOfLoopBodyNode = context.createNode();
    let updateNode = context.createNode();
    let finalNode = context.createNode();

    if (forStatement.test) {
        // If the loop has a test expression,
        // we need to add truthy and falsy edges
        let truthyCondition = forStatement.test;
        let falsyCondition = negateTruthiness(truthyCondition);

        // Create edges labels
        let truthyConditionLabel = stringify(truthyCondition);
        let falsyConditionLabel = stringify(falsyCondition);

        // Add truthy and falsy edges
        beginOfLoopBodyNode.appendConditionallyTo(testDecisionNode, truthyConditionLabel, truthyCondition);
        finalNode.appendConditionallyTo(testDecisionNode, falsyConditionLabel, falsyCondition);
    } else {
        // If the loop doesn't have a test expression,
        // the loop body starts unconditionally after the initialization
        beginOfLoopBodyNode.appendEpsilonEdgeTo(testDecisionNode);
    }

    context.enclosingStatements.push({
        type: EnclosingStatementType.OtherStatement,
        continueTarget: updateNode,
        breakTarget: finalNode,
        label: label
    });

    let loopBodyCompletion = parseStatement(forStatement.body, beginOfLoopBodyNode, context);

    context.enclosingStatements.pop();

    if (forStatement.update) {
        // If the loop has an update expression,
        // parse it and append it to the end of the loop body
        let endOfUpdateNode = parseExpression(forStatement.update, updateNode, context);
        testDecisionNode.appendEpsilonEdgeTo(endOfUpdateNode);
    } else {
        // If the loop doesn't have an update expression,
        // treat the update node as a dummy and point it to the test node
        testDecisionNode.appendEpsilonEdgeTo(updateNode);
    }

    if (loopBodyCompletion.normal) {
        // If we reached the end of the loop body through normal control flow,
        // continue regularly with the update
        updateNode.appendEpsilonEdgeTo(loopBodyCompletion.normal);
    }

    return { normal: finalNode };
}

function parseForInStatement(forInStatement: ESTree.ForInStatement, currentNode: FlowNode, context: ParsingContext, label?: string): Completion {
    let stringifiedRight = stringify(forInStatement.right);

    let variableDeclarator = forInStatement.left.declarations[0];
    let variableName = variableDeclarator.id.name;

    let conditionNode = context.createNode()
        .appendTo(currentNode, stringifiedRight);

    let startOfLoopBody = context.createNode()
        .appendConditionallyTo(conditionNode, `${variableName} = <next>`, forInStatement.right);

    let finalNode = context.createNode()
        .appendConditionallyTo(conditionNode, "<no more>", null);

    context.enclosingStatements.push({
        type: EnclosingStatementType.OtherStatement,
        breakTarget: finalNode,
        continueTarget: conditionNode,
        label: label
    });

    let loopBodyCompletion = parseStatement(forInStatement.body, startOfLoopBody, context);

    context.enclosingStatements.pop();

    if (loopBodyCompletion.normal) {
        conditionNode.appendEpsilonEdgeTo(loopBodyCompletion.normal);
    }

    return { normal: finalNode };
}

function parseDebuggerStatement(debuggerStatement: ESTree.DebuggerStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    return { normal: currentNode };
}

function parseExpressionStatement(expressionStatement: ESTree.ExpressionStatement, currentNode: FlowNode, context: ParsingContext): Completion {
    return {
        normal: parseExpression(expressionStatement.expression, currentNode, context)
    };
}

function parseExpression(expression: ESTree.Expression, currentNode: FlowNode, context: ParsingContext): FlowNode {
    if (expression.type === ESTree.NodeType.SequenceExpression) {
        return parseSequenceExpression(<ESTree.SequenceExpression>expression, currentNode, context);
    }

    let expressionLabel = stringify(expression);

    return context.createNode()
        .appendTo(currentNode, expressionLabel);
}

function parseSequenceExpression(sequenceExpression: ESTree.SequenceExpression, currentNode: FlowNode, context: ParsingContext): FlowNode {
    for (let expression of sequenceExpression.expressions) {
        currentNode = parseExpression(expression, currentNode, context);
    }

    return currentNode;
}

function runFinalizersBeforeBreakOrContinue(currentNode: FlowNode, context: ParsingContext, target: EnclosingStatement): Completion {
    let enclosingStatements = context.enclosingStatements.enumerateElements();

    for (let statement of enclosingStatements) {
        if (statement.type === EnclosingStatementType.TryStatement) {
            let tryStatement = <EnclosingTryStatement>statement;

            if (tryStatement.parseFinalizer && !tryStatement.isCurrentlyInFinalizer) {
                tryStatement.isCurrentlyInFinalizer = true;
                let finalizer = tryStatement.parseFinalizer();
                tryStatement.isCurrentlyInFinalizer = false;

                finalizer.bodyEntry.appendEpsilonEdgeTo(currentNode);

                if (finalizer.bodyCompletion.normal) {
                    currentNode = finalizer.bodyCompletion.normal;
                } else {
                    return finalizer.bodyCompletion;
                }
            }
        }

        if (statement === target) {
            // We only run finalizers of `try` statements that are nested
            // within the target enclosing statement. Therefore, stop here.
            break;
        }
    }

    return { normal: currentNode };
}

function runFinalizersBeforerReturn(currentNode: FlowNode, context: ParsingContext): Completion {
    let enclosingTryStatements = <EnclosingTryStatement[]>context.enclosingStatements
        .enumerateElements()
        .filter(statement => statement.type === EnclosingStatementType.TryStatement);

    for (let tryStatement of enclosingTryStatements) {
        if (tryStatement.parseFinalizer && !tryStatement.isCurrentlyInFinalizer) {
            tryStatement.isCurrentlyInFinalizer = true;
            let finalizer = tryStatement.parseFinalizer();
            tryStatement.isCurrentlyInFinalizer = false;

            finalizer.bodyEntry.appendEpsilonEdgeTo(currentNode);

            if (finalizer.bodyCompletion.normal) {
                currentNode = finalizer.bodyCompletion.normal;
            } else {
                return finalizer.bodyCompletion;
            }
        }
    }

    return { normal: currentNode };
}

function runOptimizationPasses(graphs: ControlFlowGraph[], options: ParserOptions) {
    for (let graph of graphs) {
        if (options.passes.rewriteConstantConditionalEdges) {
            Passes.rewriteConstantConditionalEdges(graph);
        }

        Passes.removeUnreachableNodes(graph);

        if (options.passes.removeTransitNodes) {
            Passes.removeTransitNodes(graph);
        }

        Passes.collectNodesAndEdges(graph);
    }
}
