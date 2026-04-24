/* JSDoc block grouping + ordering — second half of the
 * annotation-md cleanup.
 *
 * After jsdoc-wrap has turned `@tag` text into pill spans, this
 * pass:
 *   - Wraps each `.wt-jsdoc-tag` + its following siblings into
 *     a `<span class="wt-jsdoc-block">` so pill and content
 *     render as one card. Pulls @example code blocks, @param
 *     names, and {Type} annotations into the right spots.
 *   - Drops empty @description cards, lifts every block to the
 *     container top level, synthesizes a @description card from
 *     leftover prose, and orders as:
 *       [@fileoverview?, @description?, others…]
 *
 * Exposes ns.groupJsdocBlocks(container). */
"use strict";
(() => {
  const ns = window[Symbol.for("meander:pages")];
  if (!ns) {
    return;
  }

  const firstMeaningfulChild = (parent) => {
    let node = parent.firstChild;
    while (node) {
      if (node.nodeType === 3) {
        if ((node.nodeValue ?? "").trim() !== "") {
          return node;
        }
        node = node.nextSibling;
        continue;
      }
      return node;
    }
    return null;
  };

  const absorbExampleBlock = (tagEl, block, body) => {
    /* @example: the fenced code lives as a <pre> sibling of the
     * <p> that contains the @example tag. Body-scoop only
     * reaches <p>-level siblings, so the <pre> is orphaned
     * below the description. Climb to the enclosing block-level
     * ancestor of `block` inside .annotation-md and absorb any
     * immediately-following <pre> siblings into the body. */
    if (tagEl.textContent?.toLowerCase() !== "@example") {
      return;
    }
    const annotationRoot = block.closest(".annotation-md");
    let outer = block;
    while (outer.parentElement && outer.parentElement !== annotationRoot) {
      outer = outer.parentElement;
    }
    let sibling = outer.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      if (sibling.nodeType === 3) {
        const txt = sibling.nodeValue ?? "";
        if (txt.trim() === "") {
          sibling = next;
          continue;
        }
        break;
      }
      if (sibling.nodeType === 1 && sibling.tagName === "PRE") {
        body.appendChild(sibling);
        sibling = next;
        continue;
      }
      break;
    }
  };

  const extractParamName = (tagEl, body) => {
    /* @param: pull the leading parameter name out of the body's
     * first text node. Source shape is "@param a - First …"
     * which arrives in the body as text starting "a - First…".
     * Render the name as an inline code pill next to the @PARAM
     * tag. Separator required so plain prose (`@param Builder
     * instance…`) doesn't mis-grab "Builder". */
    if (tagEl.dataset.tag !== "param") {
      return;
    }
    const firstTextNode =
      body.firstChild && body.firstChild.nodeType === 3 ? body.firstChild : null;
    const nameMatch = firstTextNode
      ? (firstTextNode.nodeValue ?? "").match(
          /^\s*([A-Za-z_$][\w$]*)\s*[-—:]\s+/,
        )
      : null;
    if (firstTextNode && nameMatch && nameMatch[1]) {
      const paramName = document.createElement("code");
      paramName.className = "wt-jsdoc-type-inline wt-jsdoc-param-name";
      paramName.textContent = nameMatch[1];
      tagEl.insertAdjacentElement("afterend", paramName);
      firstTextNode.nodeValue = (firstTextNode.nodeValue ?? "").slice(
        nameMatch[0].length,
      );
      if (firstTextNode.nodeValue === "") {
        firstTextNode.remove();
      }
    }
  };

  const liftTypeAnnotation = (tagEl, body) => {
    /* Any tag carrying a `{Type}` (@throws {Error}, @returns
     * {Promise<T>}): the regex rendered the brace-type as
     * <code class="wt-jsdoc-type-inline"> that sits as an early
     * child of the body. Pull it up next to the tag on the top
     * strip so the header reads "[THROWS] `{Error}`" with the
     * description on the next line. */
    const typeChild = firstMeaningfulChild(body);
    if (
      typeChild &&
      typeChild.nodeType === 1 &&
      typeChild.tagName === "CODE" &&
      typeChild.classList.contains("wt-jsdoc-type-inline") &&
      /^\{[^}]*\}$/.test(typeChild.textContent ?? "")
    ) {
      while (body.firstChild && body.firstChild !== typeChild) {
        body.firstChild.remove();
      }
      typeChild.classList.add("wt-jsdoc-type");
      tagEl.insertAdjacentElement("afterend", typeChild);
      /* Strip leading whitespace / separator from the next text
       * node so the description starts clean. */
      const nextTextNode =
        body.firstChild && body.firstChild.nodeType === 3
          ? body.firstChild
          : null;
      if (nextTextNode) {
        nextTextNode.nodeValue = (nextTextNode.nodeValue ?? "").replace(
          /^\s*(?:[-—:]\s*)?/,
          "",
        );
        if (nextTextNode.nodeValue === "") {
          nextTextNode.remove();
        }
      }
    }
  };

  const buildBlocks = (container) => {
    /* Group each .wt-jsdoc-tag + its following siblings into a
     * <span class="wt-jsdoc-block">. Walk forward; reverse-walk
     * nests cards inside each other. */
    const tags = [...container.querySelectorAll(".wt-jsdoc-tag")];
    for (const tagEl of tags) {
      const parent = tagEl.parentElement;
      if (!parent || parent.classList.contains("wt-jsdoc-block")) {
        continue;
      }
      const block = document.createElement("span");
      block.className = "wt-jsdoc-block";
      parent.insertBefore(block, tagEl);
      block.appendChild(tagEl);
      const body = document.createElement("span");
      body.className = "wt-jsdoc-body";
      block.appendChild(body);
      let cur = block.nextSibling;
      while (cur) {
        const next = cur.nextSibling;
        if (cur.nodeType === 1 && cur.classList?.contains("wt-jsdoc-tag")) {
          break;
        }
        /* Trim stray <br> at head of body. */
        if (
          body.childNodes.length === 0 &&
          cur.nodeType === 1 &&
          cur.nodeName === "BR"
        ) {
          cur.remove();
          cur = next;
          continue;
        }
        body.appendChild(cur);
        cur = next;
      }
      absorbExampleBlock(tagEl, block, body);
      extractParamName(tagEl, body);
      liftTypeAnnotation(tagEl, body);
    }
  };

  const orderBlocks = (container) => {
    /* Final order:
     *   [@fileoverview?, explicit @description?, synthetic
     *    @description from leftover prose?, others in source
     *    order]. */
    const allBlocks = [...container.querySelectorAll(".wt-jsdoc-block")];
    const emptyDescs = allBlocks.filter((b) => {
      const isDesc = b.querySelector(
        ':scope > .wt-jsdoc-tag[data-tag="description"]',
      );
      if (!isDesc) {
        return false;
      }
      const body = b.querySelector(":scope > .wt-jsdoc-body");
      return !body || (body.textContent ?? "").trim() === "";
    });
    for (const b of emptyDescs) {
      b.remove();
    }
    const liveBlocks = allBlocks.filter((b) => !emptyDescs.includes(b));
    const explicitDesc = liveBlocks.find((b) =>
      b.querySelector(':scope > .wt-jsdoc-tag[data-tag="description"]'),
    );
    const otherBlocks = liveBlocks.filter((b) => b !== explicitDesc);
    if (explicitDesc) {
      explicitDesc.classList.add("wt-jsdoc-block-desc");
    }
    /* Lift every tag block out of its markdown-wrapper parent
     * so the synthesis below only sees true leftover prose. */
    for (const b of liveBlocks) {
      if (b.parentElement !== container) {
        container.appendChild(b);
      }
    }
    /* Synthesize a @DESCRIPTION card from leftover prose when
     * no explicit one exists. */
    let syntheticDesc = null;
    if (!explicitDesc) {
      const descBlock = document.createElement("span");
      descBlock.className = "wt-jsdoc-block wt-jsdoc-block-desc";
      const descTag = document.createElement("span");
      descTag.className = "wt-jsdoc-tag";
      descTag.textContent = "@description";
      descTag.dataset.tag = "description";
      descBlock.appendChild(descTag);
      const descBody = document.createElement("span");
      descBody.className = "wt-jsdoc-body";
      descBlock.appendChild(descBody);
      for (const node of [...container.childNodes]) {
        if (node.nodeType === 1 && node.classList.contains("wt-jsdoc-block")) {
          continue;
        }
        descBody.appendChild(node);
      }
      if ((descBody.textContent ?? "").trim() !== "") {
        syntheticDesc = descBlock;
      }
    }
    const fileoverview = otherBlocks.find((b) =>
      b.querySelector(':scope > .wt-jsdoc-tag[data-tag="fileoverview"]'),
    );
    const otherBlocksMinusOverview = otherBlocks.filter((b) => b !== fileoverview);
    const ordered = [
      ...(fileoverview ? [fileoverview] : []),
      ...(explicitDesc ? [explicitDesc] : []),
      ...(syntheticDesc ? [syntheticDesc] : []),
      ...otherBlocksMinusOverview,
    ];
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      container.insertBefore(ordered[i], container.firstChild);
    }
  };

  ns.groupJsdocBlocks = (container) => {
    buildBlocks(container);
    orderBlocks(container);
  };
})();
