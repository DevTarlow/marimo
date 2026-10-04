/**
 * The two places MCP's wire format meets the model's.
 *
 * Both are narrowings, and both fail loudly at the far end rather than here: a
 * schema the endpoint rejects fails the whole turn with a complaint about the
 * tool list, and a result the client renders as empty looks to the model exactly
 * like a tool that returned nothing. So the cases worth testing are the awkward
 * ones a real server actually sends.
 */
import {describe, expect, it} from 'vitest';

import {renderResult, sanitiseSchema} from './client.js';

describe('sanitiseSchema', () => {
  it('turns a missing schema into an empty object schema', () => {
    expect(sanitiseSchema(undefined)).toEqual({type: 'object', properties: {}});
    expect(sanitiseSchema(null)).toEqual({type: 'object', properties: {}});
    expect(sanitiseSchema('nonsense')).toEqual({
      type: 'object',
      properties: {},
    });
  });

  /*
   * Each of these is a key that at least one OpenAI-compatible endpoint refuses
   * outright. Passing them through is not "slightly wrong" — it is a 400 on
   * every request that carries the tool.
   */
  it('drops the keys the endpoints reject', () => {
    const schema = sanitiseSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'x',
      $ref: '#/defs/y',
      additionalProperties: false,
      patternProperties: {},
      examples: [1],
      title: 'A title',
      type: 'object',
      properties: {a: {type: 'string'}},
    });

    expect(schema).toEqual({
      type: 'object',
      properties: {a: {type: 'string'}},
    });
  });

  it('lowercases a type the endpoint wants lowercase', () => {
    // ADK's own dialect uses `Type.STRING`-style uppercase names; a server that
    // echoes that shape back must not reach the endpoint as-is.
    const schema = sanitiseSchema({
      type: 'OBJECT',
      properties: {a: {type: 'STRING'}},
    });
    expect(schema['type']).toBe('object');
    expect((schema['properties'] as Record<string, unknown>)['a']).toEqual({
      type: 'string',
    });
  });

  it('collapses a union with null to its meaningful branch', () => {
    // `["string","null"]` is how these schemas spell "optional", and optionality
    // is already carried by `required`.
    const schema = sanitiseSchema({
      type: 'object',
      properties: {
        a: {type: ['string', 'null']},
        b: {type: ['null', 'integer']},
        c: {type: ['null']},
      },
    });

    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties['a']).toEqual({type: 'string'});
    expect(properties['b']).toEqual({type: 'integer'});
    // Nothing left but null: still has to be some usable type rather than absent.
    expect(properties['c']).toEqual({type: 'string'});
  });

  it('keeps an enum as strings, because the endpoint takes no other kind', () => {
    const schema = sanitiseSchema({
      type: 'object',
      properties: {mode: {type: 'string', enum: ['fast', 'slow', 3, null]}},
    });
    const mode = (schema['properties'] as Record<string, {enum?: string[]}>)[
      'mode'
    ];
    expect(mode?.enum).toEqual(['fast', 'slow', '3']);
  });

  it('keeps a scalar default but drops one it cannot express', () => {
    const schema = sanitiseSchema({
      type: 'object',
      properties: {
        a: {type: 'string', default: 'hello'},
        b: {type: 'number', default: 3},
        c: {type: 'boolean', default: false},
        d: {type: 'object', default: {nested: true}},
        e: {type: 'array', default: [1, 2]},
      },
    });
    const properties = schema['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties['a']?.['default']).toBe('hello');
    expect(properties['b']?.['default']).toBe(3);
    expect(properties['c']?.['default']).toBe(false);
    expect(properties['d']).not.toHaveProperty('default');
    expect(properties['e']).not.toHaveProperty('default');
  });

  it('sanitises nested properties and array items, not only the top level', () => {
    // The nesting is where a naive implementation stops, and it is exactly where
    // a real server puts `$schema` and unions.
    const schema = sanitiseSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: {depth: {type: ['integer', 'null'], minimum: '1'}},
        },
        tags: {
          type: 'array',
          items: {type: 'string', $comment: 'drop me'},
        },
      },
    });

    const properties = schema['properties'] as Record<string, any>;
    expect(properties['nested'].additionalProperties).toBeUndefined();
    expect(properties['nested'].properties.depth).toEqual({
      type: 'integer',
      minimum: 1,
    });
    expect(properties['tags'].items).toEqual({type: 'string'});
  });

  it('keeps only the required names that are real strings', () => {
    const schema = sanitiseSchema({
      type: 'object',
      properties: {a: {type: 'string'}},
      required: ['a', 5, null, {nope: true}],
    });
    expect(schema['required']).toEqual(['a']);
  });

  it('omits an empty required list rather than sending one', () => {
    const schema = sanitiseSchema({type: 'object', required: []});
    expect(schema).not.toHaveProperty('required');
  });

  it('rewrites oneOf as anyOf', () => {
    // Not the same thing — `oneOf` means exactly one branch matches — but no
    // OpenAI-compatible endpoint distinguishes them, and a schema it refuses is
    // worse than one that is slightly too permissive.
    const schema = sanitiseSchema({
      type: 'object',
      properties: {
        either: {oneOf: [{type: 'string'}, {type: 'number'}]},
      },
    });
    const either = (schema['properties'] as Record<string, any>)['either'];
    expect(either.anyOf).toEqual([{type: 'string'}, {type: 'number'}]);
    expect(either).not.toHaveProperty('oneOf');
  });

  it('keeps a known format and drops an invented one', () => {
    const schema = sanitiseSchema({
      type: 'object',
      properties: {
        when: {type: 'string', format: 'date-time'},
        who: {type: 'string', format: 'email'},
        id: {type: 'string', format: 'uuid'},
        odd: {type: 'string', format: 'not-a-real-format'},
      },
    });
    const properties = schema['properties'] as Record<string, any>;
    expect(properties['when'].format).toBe('date-time');
    expect(properties['who'].format).toBe('email');
    expect(properties['id'].format).toBe('uuid');
    expect(properties['odd']).not.toHaveProperty('format');
  });

  it('coerces numeric constraints that arrive as strings', () => {
    // Gemini's schema dialect spells these as strings, and a server written
    // against that dialect sends them that way.
    const schema = sanitiseSchema({
      type: 'object',
      properties: {n: {type: 'number', maximum: '10', minimum: 1}},
      maxItems: '5',
    });
    const n = (schema['properties'] as Record<string, any>)['n'];
    expect(n.maximum).toBe(10);
    expect(n.minimum).toBe(1);
    expect(schema['maxItems']).toBe(5);
  });

  it('drops a numeric constraint that is not a number at all', () => {
    const schema = sanitiseSchema({
      type: 'object',
      properties: {n: {type: 'number', maximum: 'lots'}},
    });
    const n = (schema['properties'] as Record<string, any>)['n'];
    expect(n).not.toHaveProperty('maximum');
  });

  it('always produces an object schema, whatever it was given', () => {
    // The endpoint requires an object at the top level, so a server that
    // described its arguments as, say, an array still has to be callable.
    expect(sanitiseSchema({type: 'array', items: {type: 'string'}})).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('renderResult', () => {
  it('joins text blocks in order', () => {
    expect(
      renderResult({
        content: [
          {type: 'text', text: 'first'},
          {type: 'text', text: 'second'},
        ],
      }),
    ).toBe('first\nsecond');
  });

  it('keeps the raw text of an error result and marks it as one', () => {
    // An MCP error is a *result*, not a thrown failure: the turn continues and
    // the model is told what the server said, which is usually actionable.
    const text = renderResult({
      content: [{type: 'text', text: 'permission denied'}],
      isError: true,
    });
    expect(text).toContain('permission denied');
    expect(text).toMatch(/reported an error/iu);
  });

  /*
   * A tool that returns only an image and says nothing would otherwise look
   * identical to a tool that returned nothing at all.
   */
  it('says an image was returned rather than going quiet', () => {
    const text = renderResult({
      content: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}],
    });
    expect(text).toBe('[image: image/png]');
  });

  it('falls back to the URI for a resource with no text', () => {
    expect(
      renderResult({
        content: [{type: 'resource', resource: {uri: 'file:///a.txt'}}],
      }),
    ).toBe('[resource: file:///a.txt]');
  });

  it('prefers a resource is text when it has one', () => {
    expect(
      renderResult({
        content: [
          {type: 'resource', resource: {uri: 'file:///a.txt', text: 'contents'}},
        ],
      }),
    ).toBe('contents');
  });

  it('names a block type it does not know instead of dropping it', () => {
    expect(renderResult({content: [{type: 'hologram'}]})).toBe(
      '[hologram content]',
    );
  });

  it('says so when there is nothing, rather than returning nothing', () => {
    expect(renderResult({content: []})).toBe('(the server returned nothing)');
    expect(renderResult({})).toBe('(the server returned nothing)');
  });

  it('uses structuredContent when there are no content blocks', () => {
    const text = renderResult({content: [], structuredContent: {answer: 42}});
    expect(text).toContain('42');
  });

  it('marks truncation visibly', () => {
    // Invariant: the model must know there is more, or it believes it read
    // everything and answers confidently from half the data.
    const text = renderResult({
      content: [{type: 'text', text: 'x'.repeat(50_000)}],
    });
    expect(text.length).toBeLessThan(50_000);
    expect(text).toMatch(/\[truncated/u);
  });

  it('stringifies a result that is not an object at all', () => {
    expect(renderResult('just a string')).toContain('just a string');
  });
});
