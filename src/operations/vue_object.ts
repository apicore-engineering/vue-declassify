import { ClassDeclaration, Expression, JSDoc, printNode, PropertyAssignment, PropertyDeclaration, SourceFile, SyntaxKind, ts, TypeNode } from 'ts-morph'

import * as vue_class from './vue_class'
import * as imports from './imports'

const f = ts.factory

// Unclear how to directly plop an entire, pre-rendered comment in front.
// Forced to re-process the comment line-by-line to work with MultiLineCommentTriva.
function createDocumentation<T extends ts.Node>(target: T, docs: JSDoc[]) {
  if (docs.length > 0) {
    const comment = docs[0].compilerNode.comment

    if (comment) {
      return ts.addSyntheticLeadingComment(
        target, 
        SyntaxKind.MultiLineCommentTrivia, 
        '*\n' + // Starts with '/*'
          comment
            .split('\n')
            .map(line => ` * ${line}`)
            .join('\n')
        + '\n ', // Ends with '*/' 
        true,
      )
    }
  }

  return target
}

function classNameToPropName(
  source: SourceFile,
  vue: {
    declaration: ClassDeclaration,
  }
): ts.PropertyAssignment {
  return f.createPropertyAssignment(
    f.createIdentifier('name'),
    f.createStringLiteral(vue.declaration.getNameOrThrow(), true),
  )
}

function classPropTypeToObjectPropType(
  source: SourceFile,
  prop: {
    declaration: PropertyDeclaration
  }
): ts.PropertyAssignment {
  let initializer: ts.Expression
  const type = prop.declaration.getType()

  if (type.isString()) {
    initializer = f.createIdentifier('String')

  } else if (type.isNumber()) {
    initializer = f.createIdentifier('Number')
  
  } else if (type.isBoolean()) {
    initializer = f.createIdentifier('Boolean')

  } else {
    imports.ensure(source, 'vue', {
      named: ['PropType'],
    })

    // HACK: Create a more concise `as` expression manually.
    // TODO: Adjust Object/Function/Array based on a regular expression.
    const type = prop.declaration.getTypeNodeOrThrow()
    initializer = f.createIdentifier(`Object as PropType<${type.getText()}>`)
  }

  return f.createPropertyAssignment(
    f.createIdentifier('type'),
    initializer,
  )
}

function classPropOptionsToObjectPropOptions(
  source: SourceFile,
  prop: {
    default?: PropertyAssignment
    required?: PropertyAssignment
  }
): ts.PropertyAssignment[] {
  
  // Only permit exactly one of `default` and `required`,
  // since a default value implies required is false in Vue.
  // There actually doesn't seem to be a use-case to set both!
  if (prop.default) {
    
    // Note: I really want to just pass the compiler node, but
    // for some reason `default` is special and does not render.
    // Probably has to do with `default` being a TS keyword.
    return [
      f.createPropertyAssignment(
        f.createIdentifier('default'),
        f.createIdentifier(prop.default.getInitializerOrThrow().getText()),
      )
    ]

  } else if (prop.required) {
    return [prop.required.compilerNode]

  } else {

    // Lastly, if neither property is directly supplied, mark `required` false.
    // This is consistent with the vue-property-decorator defaults.
    return [
      f.createPropertyAssignment(
        f.createIdentifier('required'),
        f.createFalse(),
      )
    ]
  }
}

function classPropToObjectProp(
  source: SourceFile,
  prop: {
    declaration: PropertyDeclaration
    default?: PropertyAssignment
    required?: PropertyAssignment
  }
): ts.PropertyAssignment {
  return createDocumentation(
    f.createPropertyAssignment(
      f.createIdentifier(prop.declaration.getName()),
      f.createObjectLiteralExpression(
        [
          classPropTypeToObjectPropType(source, prop),
          ...classPropOptionsToObjectPropOptions(source, prop),
        ],
        true,
      ),
    ),
    prop.declaration.getJsDocs(),
  )
}

function classPropsToObjectProps(
  source: SourceFile,
  vue: {
    props: {
      declaration: PropertyDeclaration
      default?: PropertyAssignment
      required?: PropertyAssignment
    }[]
  }
): ts.PropertyAssignment {
  return f.createPropertyAssignment(
    f.createIdentifier('props'),
    f.createObjectLiteralExpression(
      vue.props.map(prop => classPropToObjectProp(source, prop)),
      true,
    ),
  )
}


function classDataToObjectData(
  source: SourceFile,
  vue: {
    data: PropertyDeclaration[],
  },
): ts.MethodDeclaration {
  const properties: ts.ObjectLiteralElementLike[] = []

  for (const declaration of vue.data) {
    const value = declaration.getInitializerOrThrow()
    const type = declaration.getTypeNode()

    // By default, initialize the data with whatever was on the other side of the declaration.
    let initializer: ts.Expression = f.createIdentifier(value.getText())

    // If there was a type declaration, port it to an `as` expression.
    if (type) {
      initializer = f.createIdentifier(`${value.getText()} as ${type.getText()}`)
    }

    properties.push(
      createDocumentation(
        f.createPropertyAssignment(
          declaration.getName(),
          initializer,
        ),
        declaration.getJsDocs(),
      )
    )
  }
  
  return f.createMethodDeclaration(
    undefined,
    undefined,
    undefined,
    f.createIdentifier('data'),
    undefined,
    undefined,
    [],
    undefined,
    f.createBlock(
      [
        f.createReturnStatement(
          f.createObjectLiteralExpression(
            properties,
            true,
          )
        ),
      ],
      true,
    )
  )
}

export function classToObject(source: SourceFile) {
  const vue = vue_class.extract(source)

  if (!vue) {
    return
  }

  const properties: ts.ObjectLiteralElementLike[] = []
  properties.push(classNameToPropName(source, vue))

  // Add any properties we inherited from the @Component decorator.
  // Note: this doesn't merge any Vue data that occurs in the class declaration.
  properties.push(...vue.decorator.properties.map(property => property.compilerNode))

  if (vue.props.length > 0) {
    properties.push(classPropsToObjectProps(source, vue))
  }

  if (vue.data.length > 0) {
    properties.push(classDataToObjectData(source, vue))
  }

  // Wrap the properties up in a call to Vue.extend().
  const component = f.createCallExpression(
    f.createIdentifier('Vue.extend'),
    undefined,
    [f.createObjectLiteralExpression(properties, true)]
  )

  // Save the docs.
  let documentation: string

  if (vue.declaration.getJsDocs().length > 0) {
    documentation = vue.declaration.getJsDocs()[0].getFullText()
  }

  // Remove the class now that we're done reading everything.
  vue.declaration.remove()

  // Add the new default export statement, printing from the object AST.
  source.addExportAssignment({
    expression: printNode(component),
    isExportEquals: false,
    leadingTrivia: writer => {
      if (documentation) {
        writer.writeLine(documentation)
      }
    }
  })
    
  source.formatText()
}
