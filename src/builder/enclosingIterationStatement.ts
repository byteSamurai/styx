/// <reference path="../estree.ts" />

module Styx {
    export interface EnclosingIterationStatement {
        label?: string;
        iterationStatement: ESTree.IterationStatement;
        finalNode: FlowNode;
    }
}