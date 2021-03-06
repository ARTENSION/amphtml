/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {CSS} from '../../../build/amp-selector-0.1.css';
import {Keycodes} from '../../../src/utils/keycodes';
import {actionServiceForDoc} from '../../../src/services';
import {closestBySelector, tryFocus} from '../../../src/dom';
import {createCustomEvent} from '../../../src/event-helper';
import {dev, user} from '../../../src/log';
import {isEnumValue} from '../../../src/types';

/**
 * Set of namespaces that can be set for lifecycle reporters.
 *
 * @enum {string}
 */
const KEYBOARD_SELECT_MODES = {
  NONE: 'none',
  FOCUS: 'focus',
  SELECT: 'select',
};


export class AmpSelector extends AMP.BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {boolean} */
    this.isMultiple_ = false;

    /** @private {!Array<!Element>} */
    this.selectedOptions_ = [];

    /** @private {!Array<!Element>} */
    this.options_ = [];

    /** @private {!Array<!Element>} */
    this.inputs_ = [];

    /** @private {boolean} */
    this.isDisabled_ = false;

    /** @private {?../../../src/service/action-impl.ActionService} */
    this.action_ = null;

    /**
     * The index of the option that should receive tab focus. Only one
     * option should ever receive tab focus, with the other options reachable
     * by arrow keys when the option is in focus.
     * @private {number}
     */
    this.focusedIndex_ = 0;

    /** @private {!KEYBOARD_SELECT_MODES} */
    this.kbSelectMode_ = KEYBOARD_SELECT_MODES.NONE;
  }

  /** @override */
  isLayoutSupported() {
    return true;
  }

  /** @override */
  buildCallback() {
    this.action_ = actionServiceForDoc(this.element);
    this.isMultiple_ = this.element.hasAttribute('multiple');
    this.isDisabled_ = this.element.hasAttribute('disabled');

    this.element.setAttribute('role', 'listbox');

    if (this.isMultiple_) {
      this.element.setAttribute('aria-multiselectable', 'true');
    }

    if (this.isDisabled_) {
      this.element.setAttribute('aria-disabled', 'true');
    }

    let kbSelectMode = this.element.getAttribute('keyboard-select-mode');
    if (!kbSelectMode) {
      kbSelectMode = KEYBOARD_SELECT_MODES.NONE;
    }
    user().assert(isEnumValue(KEYBOARD_SELECT_MODES, kbSelectMode),
        'Invalid keyboard-select-mode');
    user().assert(
        !(this.isMultiple_ && kbSelectMode == KEYBOARD_SELECT_MODES.SELECT),
        '[keyboard-select-mode=select] not supported for multiple ' +
        'selection amp-selector');
    this.kbSelectMode_ = kbSelectMode;

    this.init_();
    if (!this.isDisabled_) {
      this.element.addEventListener('click', this.clickHandler_.bind(this));
      if (this.kbSelectMode_ != KEYBOARD_SELECT_MODES.NONE) {
        this.element.addEventListener('keydown',
            this.keyDownHandler_.bind(this));
      }
    }
  }

  /** @override */
  mutatedAttributesCallback(mutations) {
    const selected = mutations['selected'];
    if (selected !== undefined) {
      this.selectedAttributeMutated_(selected);
    }
  }

  /**
   * Handles mutation of the `selected` attribute.
   * @param {null|boolean|string|number|Array|Object} newValue
   * @private
   */
  selectedAttributeMutated_(newValue) {
    if (newValue === null) {
      this.clearAllSelections_();
      return;
    }
    let selectedArray = Array.isArray(newValue) ? newValue : [newValue];
    // Only use first value if multiple selection is disabled.
    if (!this.isMultiple_) {
      selectedArray = selectedArray.slice(0, 1);
    }
    // Convert array values to strings and create map for fast lookup.
    const selectedMap = selectedArray.reduce((map, value) => {
      map[value] = true;
      return map;
    }, Object.create(null));
    // Iterate through elements and toggle selection as necessary.
    for (let i = 0; i < this.options_.length; i++) {
      const element = this.options_[i];
      const option = element.getAttribute('option');
      if (selectedMap[option]) {
        this.setSelection_(element);
      } else {
        this.clearSelection_(element);
      }
    }
    this.updateFocus_();
    // Update inputs.
    this.setInputs_();
  }

  /**
   * Determine which option should receive focus first and set tabIndex
   * on all options accordingly. When kb-select-mode is not 'none',
   * the selector's focus should behave like focus on a set of radio buttons.
   * In multi-select selectors, focus should just go to the first option.
   * In single-select selectors, focus should go to the initially selected
   * option, or to the first option if none are initially selected.
   * @private
   */
  updateFocus_() {
    if (this.kbSelectMode_ == KEYBOARD_SELECT_MODES.NONE) {
      // Don't manage focus.
      return;
    }

    this.options_.forEach(option => {
      option.tabIndex = -1;
    });

    let initialFocusedElement;
    if (this.isMultiple_) {
      initialFocusedElement = this.options_[0];
    } else {
      initialFocusedElement = this.selectedOptions_[0] || this.options_[0];
    }
    if (initialFocusedElement) {
      this.focusedIndex_ = this.options_.indexOf(initialFocusedElement);
      initialFocusedElement.tabIndex = 0;
    }
  }

  /**
   * @private
   */
  init_() {
    const options = [].slice.call(this.element.querySelectorAll('[option]'));
    options.forEach(option => {
      option.setAttribute('role', 'option');
      if (option.hasAttribute('disabled')) {
        option.setAttribute('aria-disabled', 'true');
      }
      if (option.hasAttribute('selected')) {
        this.setSelection_(option);
      } else {
        this.clearSelection_(option);
      }
      option.tabIndex = 0;
      this.options_.push(option);
    });
    this.updateFocus_();
    this.setInputs_();
  }

  /**
   * Creates inputs for the currently selected elements and returns a string
   * array of their option values.
   * @note Ignores elements that have `disabled` attribute set.
   * @return {!Array<string>}
   * @private
   */
  setInputs_() {
    const selectedValues = [];
    const elementName = this.element.getAttribute('name');
    if (!elementName || this.isDisabled_) {
      return selectedValues;
    }
    const formId = this.element.getAttribute('form');

    this.inputs_.forEach(input => {
      this.element.removeChild(input);
    });
    this.inputs_ = [];
    const doc = this.win.document;
    const fragment = doc.createDocumentFragment();
    this.selectedOptions_.forEach(option => {
      if (!option.hasAttribute('disabled')) {
        const hidden = doc.createElement('input');
        const value = option.getAttribute('option');
        hidden.setAttribute('type', 'hidden');
        hidden.setAttribute('name', elementName);
        hidden.setAttribute('value', value);
        if (formId) {
          hidden.setAttribute('form', formId);
        }
        this.inputs_.push(hidden);
        fragment.appendChild(hidden);
        selectedValues.push(value);
      }
    });
    this.element.appendChild(fragment);
    return selectedValues;
  }

  /**
   * Handles user selection on an option.
   * @param {!Element} el The element selected.
   */
  onOptionPicked_(el) {
    if (el.hasAttribute('disabled')) {
      return;
    }

    this.mutateElement(() => {
      /** @type {?Array<string>} */
      let selectedValues;
      if (el.hasAttribute('selected')) {
        if (this.isMultiple_) {
          this.clearSelection_(el);
          selectedValues = this.setInputs_();
        }
      } else {
        this.setSelection_(el);
        selectedValues = this.setInputs_();
      }

      // Don't trigger action or update focus if
      // selected values haven't changed.
      if (selectedValues) {
        this.updateFocus_();
        // Trigger 'select' event with two data params:
        // 'targetOption' - option value of the selected or deselected element.
        // 'selectedOptions' - array of option values of selected elements.
        const name = 'select';
        const selectEvent =
            createCustomEvent(this.win, `amp-selector.${name}`, {
              targetOption: el.getAttribute('option'),
              selectedOptions: selectedValues,
            });
        this.action_.trigger(this.element, name, selectEvent);
      }
    });
  }

  /**
   * Handles click events for the selectables.
   * @param {!Event} event
   */
  clickHandler_(event) {
    let el = dev().assertElement(event.target);
    if (!el) {
      return;
    }
    if (!el.hasAttribute('option')) {
      el = closestBySelector(el, '[option]');
    }
    if (el) {
      this.onOptionPicked_(el);
    }
  }

  /**
   * Handles keyboard events for the selectables.
   * @param {!Event} event
   */
  keyDownHandler_(event) {
    const isLtr = this.win.document.body.getAttribute('dir') != 'rtl';
    let dir = 0;

    switch (event.keyCode) {
      case Keycodes.LEFT_ARROW:
        // Left is considered 'previous' in LTR and 'next' in RTL.
        dir = isLtr ? -1 : 1;
        break;
      case Keycodes.UP_ARROW:
        // Up is considered 'previous' in both LTR and RTL.
        dir = -1;
        break;
      case Keycodes.RIGHT_ARROW:
        // Right is considered 'next' in LTR and 'previous' in RTL.
        dir = isLtr ? 1 : -1;
        break;
      case Keycodes.DOWN_ARROW:
        // Down is considered 'next' in both LTR and RTL.
        dir = 1;
        break;
    }

    if (dir == 0) {
      return;
    }
    event.preventDefault();

    // Make currently selected option unfocusable
    this.options_[this.focusedIndex_].tabIndex = -1;

    // Change the focus to the next element in the specified direction.
    // The selection should loop around if the user attempts to go one
    // past the beginning or end.
    this.focusedIndex_ = (this.focusedIndex_ + dir) % this.options_.length;
    if (this.focusedIndex_ < 0) {
      this.focusedIndex_ = this.focusedIndex_ + this.options_.length;
    }

    // Focus newly selected option
    const newSelectedOption = this.options_[this.focusedIndex_];
    newSelectedOption.tabIndex = 0;
    tryFocus(newSelectedOption);
    if (this.kbSelectMode_ == KEYBOARD_SELECT_MODES.SELECT) {
      this.onOptionPicked_(newSelectedOption);
    }
  }

  /**
   * Clears a given element from the list of selected options.
   * @param {!Element} element.
   * @private
   */
  clearSelection_(element) {
    element.removeAttribute('selected');
    element.setAttribute('aria-selected', 'false');
    const selIndex = this.selectedOptions_.indexOf(element);
    if (selIndex !== -1) {
      this.selectedOptions_.splice(selIndex, 1);
    }
  }

  /**
   * Clears all selected options.
   * @private
   */
  clearAllSelections_() {
    while (this.selectedOptions_.length > 0) {
      // Clear selected options for single select.
      const el = this.selectedOptions_.pop();
      this.clearSelection_(el);
    }
  }

  /**
   * Marks a given element as selected and clears the others if required.
   * @param {!Element} element.
   * @private
   */
  setSelection_(element) {
    // Exit if `element` is already selected.
    if (this.selectedOptions_.includes(element)) {
      return;
    }
    if (!this.isMultiple_) {
      this.clearAllSelections_();
    }
    element.setAttribute('selected', '');
    element.setAttribute('aria-selected', 'true');
    this.selectedOptions_.push(element);
  }
}

AMP.registerElement('amp-selector', AmpSelector, CSS);
