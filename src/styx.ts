///<reference path="../definitions/lodash.d.ts"/>
///<reference path="estree.ts"/>
///<reference path="types.ts"/>

module Styx {
    export function parse(node: ESTree.Node): ControlFlowGraph {
        if (!_.isObject(node) || !node.type) {
            throw Error("Invalid node: 'type' property required");
        }

        if (node.type === ESTree.NodeType.Program) {
            return parseProgram(<ESTree.Program>node);
        }

        throw Error(`The node type '${node.type}' is not supported`);
    }

    function parseProgram(program: ESTree.Program): ControlFlowGraph {
        var cfg = new ControlFlowGraph();

        parseStatements(program.body, cfg.entry);

        return cfg;
    }

    function parseStatements(statements: ESTree.Statement[], currentFlowNode: FlowNode) {
        for (let statement of statements) {
            currentFlowNode = parseStatement(statement, currentFlowNode);
        }
    }

    function parseStatement(statement: ESTree.Statement, currentFlowNode: FlowNode): FlowNode {
        if (statement.type === ESTree.NodeType.EmptyStatement) {
            currentFlowNode = createNodeAndAppendTo(currentFlowNode);
        } else if (statement.type === ESTree.NodeType.VariableDeclaration) {
            let declaration = <ESTree.VariableDeclaration>statement;
            currentFlowNode = parseVariableDeclaration(declaration, currentFlowNode);
        } else if (statement.type === ESTree.NodeType.IfStatement) {
            let ifStatement = <ESTree.IfStatement>statement;
            currentFlowNode = parseIfStatement(ifStatement, currentFlowNode);
        } else {
            throw Error(`Encountered unsupported statement type '${statement.type}'`);
        }

        return currentFlowNode;
    }

    function parseVariableDeclaration(declaration: ESTree.VariableDeclaration, currentFlowNode: FlowNode): FlowNode {
        for (let declarator of declaration.declarations) {
            currentFlowNode = createNodeAndAppendTo(currentFlowNode);
        }

        return currentFlowNode;
    }

    function parseIfStatement(ifStatement: ESTree.IfStatement, currentFlowNode: FlowNode): FlowNode {
        return ifStatement.alternate === null
            ? parseSimpleIfStatement(ifStatement, currentFlowNode)
            : parseIfElseStatement(ifStatement, currentFlowNode);
    }

    function parseSimpleIfStatement(ifStatement: ESTree.IfStatement, currentFlowNode: FlowNode): FlowNode {
        let ifNode = createNodeAndAppendTo(currentFlowNode);
        let finalNode = createNodeAndAppendTo(ifNode);

        let edgeToFinalNode = new FlowEdge(finalNode);
        currentFlowNode.addOutgoingEdge(edgeToFinalNode);

        return finalNode;
    }

    function parseIfElseStatement(ifStatement: ESTree.IfStatement, currentFlowNode: FlowNode): FlowNode {
        let ifNode = createNodeAndAppendTo(currentFlowNode);
        let elseNode = createNodeAndAppendTo(currentFlowNode);

        return createNodeAndAppendTo(ifNode, elseNode);
    }

    function createNodeAndAppendTo(node: FlowNode, ...otherNodes: FlowNode[]): FlowNode {
        let newNode = new FlowNode();
        let nodes = [node, ...otherNodes];

        for (let node of nodes) {
            let edge = new FlowEdge(newNode);
            node.addOutgoingEdge(edge);
        }

        return newNode;
    }
}
