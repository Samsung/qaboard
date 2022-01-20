// https://raw.githubusercontent.com/picturae/openseadragonselection/master/src/selection.js
var OpenSeadragon = require('openseadragon')


OpenSeadragon.Viewer.prototype.selection = function (options) {
    if (!this.selectionInstance || options) {
        options = options || {};
        options.viewer = this;
        this.selectionInstance = new OpenSeadragon.Selection(options);
    }
    return this.selectionInstance;
};


/**
* @class Selection
* @classdesc Provides functionality for selecting part of an image
* @memberof OpenSeadragon
* @param {Object} options
*/
OpenSeadragon.Selection = function (options) {

    OpenSeadragon.extend(true, this, {
        // internal state properties
        viewer: null,
        isSelecting: false,
        buttonActiveImg: false,
        rectDone: true,

        // options
        element: null,
        toggleButton: null,
        showSelectionControl: true,
        showConfirmDenyButtons: true,
        styleConfirmDenyButtons: true,
        returnPixelCoordinates: true,
        keyboardShortcut: 'c',
        rect: null,
        allowRotation: true,
        startRotated: false, // useful for rotated crops
        startRotatedHeight: 0.1,
        restrictToImage: false,
        onSelection: null,
        prefixUrl: null,
        navImages: {
            selection: {
                REST: 'selection_rest.png',
                GROUP: 'selection_grouphover.png',
                HOVER: 'selection_hover.png',
                DOWN: 'selection_pressed.png'
            },
            selectionConfirm: {
                REST: 'selection_confirm_rest.png',
                GROUP: 'selection_confirm_grouphover.png',
                HOVER: 'selection_confirm_hover.png',
                DOWN: 'selection_confirm_pressed.png'
            },
            selectionCancel: {
                REST: 'selection_cancel_rest.png',
                GROUP: 'selection_cancel_grouphover.png',
                HOVER: 'selection_cancel_hover.png',
                DOWN: 'selection_cancel_pressed.png'
            },
        },
        handleStyle: {
            top: '50%',
            left: '50%',
            width: '6px',
            height: '6px',
            margin: '-4px 0 0 -4px',
            background: '#000',
            border: '1px solid #ccc'
        },
        cornersStyle: {
            width: '6px',
            height: '6px',
            background: '#000',
            border: '1px solid #ccc'
        }

    }, options);

    OpenSeadragon.extend(true, this.navImages, this.viewer.navImages);

    if (!this.element) {
        this.element = OpenSeadragon.makeNeutralElement('div');
        this.element.style.background = 'rgba(0, 0, 0, 0.1)';
        this.element.className = 'selection-box';
    }
    this.borders = this.borders || [];
    var handle;
    var corners = [];
    for (var i = 0; i < 4; i++) {
        if (!this.borders[i]) {
            this.borders[i] = OpenSeadragon.makeNeutralElement('div');
            this.borders[i].className = 'border-' + i;
            this.borders[i].style.position = 'absolute';
            this.borders[i].style.width = '1px';
            this.borders[i].style.height = '1px';
            this.borders[i].style.background = '#fff';
        }

        handle = OpenSeadragon.makeNeutralElement('div');
        handle.className = 'border-' + i + '-handle';
        handle.style.position = 'absolute';
        handle.style.top = this.handleStyle.top;
        handle.style.left = this.handleStyle.left;
        handle.style.width = this.handleStyle.width;
        handle.style.height = this.handleStyle.height;
        handle.style.margin = this.handleStyle.margin;
        handle.style.background = this.handleStyle.background;
        handle.style.border = this.handleStyle.border;
        new OpenSeadragon.MouseTracker({
            element: this.borders[i],
            dragHandler: onBorderDrag.bind(this, i),
            dragEndHandler: onBorderDragEnd.bind(this, i),
        });

        corners[i] = OpenSeadragon.makeNeutralElement('div');
        corners[i].className = 'corner-' + i + '-handle';
        corners[i].style.position = 'absolute';
        corners[i].style.width = this.cornersStyle.width;
        corners[i].style.height = this.cornersStyle.height;
        corners[i].style.background = this.cornersStyle.background;
        corners[i].style.border = this.cornersStyle.border;
        new OpenSeadragon.MouseTracker({
            element: corners[i],
            dragHandler: onBorderDrag.bind(this, i + 0.5),
            dragEndHandler: onBorderDragEnd.bind(this, i),
        });

        this.borders[i].appendChild(handle);
        this.element.appendChild(this.borders[i]);
        // defer corners, so they are appended last
        setTimeout(this.element.appendChild.bind(this.element, corners[i]), 0);
    }
    this.borders[0].style.top = 0;
    this.borders[0].style.width = '100%';
    this.borders[1].style.right = 0;
    this.borders[1].style.height = '100%';
    this.borders[2].style.bottom = 0;
    this.borders[2].style.width = '100%';
    this.borders[3].style.left = 0;
    this.borders[3].style.height = '100%';
    corners[0].style.top = '-3px';
    corners[0].style.left = '-3px';
    corners[1].style.top = '-3px';
    corners[1].style.right = '-3px';
    corners[2].style.bottom = '-3px';
    corners[2].style.right = '-3px';
    corners[3].style.bottom = '-3px';
    corners[3].style.left = '-3px';

    if (!this.overlay) {
        this.overlay = new OpenSeadragon.SelectionOverlay(this.element, this.rect || new OpenSeadragon.SelectionRect());
    }

    this.innerTracker = new OpenSeadragon.MouseTracker({
        element: this.element,
        clickTimeThreshold: this.viewer.clickTimeThreshold,
        clickDistThreshold: this.viewer.clickDistThreshold,
        dragHandler: OpenSeadragon.delegate(this, onInsideDrag),
        dragEndHandler: OpenSeadragon.delegate(this, onInsideDragEnd),
        // keyHandler:         OpenSeadragon.delegate( this, onKeyPress ),
        clickHandler: OpenSeadragon.delegate(this, onClick),
        // scrollHandler:      OpenSeadragon.delegate( this.viewer, this.viewer.innerTracker.scrollHandler ),
        // pinchHandler:       OpenSeadragon.delegate( this.viewer, this.viewer.innerTracker.pinchHandler ),
    });

    this.outerTracker = new OpenSeadragon.MouseTracker({
        element: this.viewer.canvas,
        clickTimeThreshold: this.viewer.clickTimeThreshold,
        clickDistThreshold: this.viewer.clickDistThreshold,
        dragHandler: OpenSeadragon.delegate(this, onOutsideDrag),
        dragEndHandler: OpenSeadragon.delegate(this, onOutsideDragEnd),
        clickHandler: OpenSeadragon.delegate(this, onClick),
        startDisabled: !this.isSelecting,
    });

    if (this.keyboardShortcut) {
        OpenSeadragon.addEvent(
            this.viewer.container,
            'keypress',
            OpenSeadragon.delegate(this, onKeyPress),
            { passive: true }
        );
    }

    var prefix = this.prefixUrl || this.viewer.prefixUrl || '';
    var useGroup = this.viewer.buttonGroup && this.viewer.buttonGroup.buttons;
    var anyButton = useGroup ? this.viewer.buttonGroup.buttons[0] : null;
    var onFocusHandler = anyButton ? anyButton.onFocus : null;
    var onBlurHandler = anyButton ? anyButton.onBlur : null;
    if (this.showSelectionControl) {
        this.toggleButton = new OpenSeadragon.Button({
            element: this.toggleButton ? OpenSeadragon.getElement(this.toggleButton) : null,
            clickTimeThreshold: this.viewer.clickTimeThreshold,
            clickDistThreshold: this.viewer.clickDistThreshold,
            tooltip: 'Select a region to see its histogram',
            srcRest: prefix + this.navImages.selection.REST,
            srcGroup: prefix + this.navImages.selection.GROUP,
            srcHover: prefix + this.navImages.selection.HOVER,
            srcDown: prefix + this.navImages.selection.DOWN,
            onRelease: this.toggleState.bind(this),
            onFocus: onFocusHandler,
            onBlur: onBlurHandler
        });
        if (useGroup) {
            this.viewer.buttonGroup.buttons.push(this.toggleButton);
            this.viewer.buttonGroup.element.appendChild(this.toggleButton.element);
        }
        if (this.toggleButton.imgDown) {
            this.buttonActiveImg = this.toggleButton.imgDown.cloneNode(true);
            this.toggleButton.element.appendChild(this.buttonActiveImg);
        }
    }
    if (this.showConfirmDenyButtons) {
        this.confirmButton = new OpenSeadragon.Button({
            element: this.confirmButton ? OpenSeadragon.getElement(this.confirmButton) : null,
            clickTimeThreshold: this.viewer.clickTimeThreshold,
            clickDistThreshold: this.viewer.clickDistThreshold,
            tooltip: 'Confirm selection',
            srcRest: prefix + this.navImages.selectionConfirm.REST,
            srcGroup: prefix + this.navImages.selectionConfirm.GROUP,
            srcHover: prefix + this.navImages.selectionConfirm.HOVER,
            srcDown: prefix + this.navImages.selectionConfirm.DOWN,
            onRelease: this.confirm.bind(this),
            onFocus: onFocusHandler,
            onBlur: onBlurHandler
        });
        var confirm = this.confirmButton.element;
        confirm.classList.add('confirm-button');
        this.element.appendChild(confirm);

        this.cancelButton = new OpenSeadragon.Button({
            element: this.cancelButton ? OpenSeadragon.getElement(this.cancelButton) : null,
            clickTimeThreshold: this.viewer.clickTimeThreshold,
            clickDistThreshold: this.viewer.clickDistThreshold,
            tooltip: 'Cancel selection',
            srcRest: prefix + this.navImages.selectionCancel.REST,
            srcGroup: prefix + this.navImages.selectionCancel.GROUP,
            srcHover: prefix + this.navImages.selectionCancel.HOVER,
            srcDown: prefix + this.navImages.selectionCancel.DOWN,
            onRelease: this.cancel.bind(this),
            onFocus: onFocusHandler,
            onBlur: onBlurHandler
        });
        var cancel = this.cancelButton.element;
        cancel.classList.add('cancel-button');
        this.element.appendChild(cancel);

        if (this.styleConfirmDenyButtons) {
            confirm.style.position = 'absolute';
            confirm.style.top = '50%';
            confirm.style.left = '50%';
            confirm.style.transform = 'translate(-100%, -50%)';

            cancel.style.position = 'absolute';
            cancel.style.top = '50%';
            cancel.style.left = '50%';
            cancel.style.transform = 'translate(0, -50%)';
        }
    }

    this.viewer.addHandler('selection', this.onSelection);
    this.viewer.addHandler('selection_change', this.onSelectionChange);

    this.viewer.addHandler('open', this.draw.bind(this));
    this.viewer.addHandler('animation', this.draw.bind(this));
    this.viewer.addHandler('resize', this.draw.bind(this));
    this.viewer.addHandler('rotate', this.draw.bind(this));
};

OpenSeadragon.extend(OpenSeadragon.Selection.prototype, OpenSeadragon.ControlDock.prototype, /** @lends OpenSeadragon.Selection.prototype */{

    toggleState: function () {
        return this.setState(!this.isSelecting);
    },

    setState: function (enabled) {
        this.isSelecting = enabled;
        // this.viewer.innerTracker.setTracking(!enabled);
        this.outerTracker.setTracking(enabled);
        enabled ? this.draw() : this.undraw();
        if (this.buttonActiveImg) {
            this.buttonActiveImg.style.visibility = enabled ? 'visible' : 'hidden';
        }
        this.viewer.raiseEvent('selection_toggle', { enabled: enabled });
        return this;
    },

    setAllowRotation: function (allowRotation) {
        this.allowRotation = allowRotation;
    },

    enable: function () {
        return this.setState(true);
    },

    disable: function () {
        return this.setState(false);
    },

    draw: function () {
        if (this.rect) {
            var imageCoords = this.rect.normalize();
            if (this.returnPixelCoordinates) {
                var real = this.viewer.viewport.viewportToImageRectangle(imageCoords);
                real = OpenSeadragon.SelectionRect.fromRect(real).round();
                real.rotation = imageCoords.rotation;
                imageCoords = real;
            }
            let top_left = this.viewer.viewport.viewportToViewerElementCoordinates(this.rect.getTopLeft());
            let bottom_left = this.viewer.viewport.viewportToViewerElementCoordinates(this.rect.getBottomLeft());
            let top_right = this.viewer.viewport.viewportToViewerElementCoordinates(this.rect.getTopRight());
            let canvasCoords = new OpenSeadragon.Rect(top_left.x, top_left.y, top_right.x - top_left.x, bottom_left.y - top_left.y)
            this.viewer.raiseEvent('selection_change', { imageCoords, canvasCoords, viewportCoords: this.rect });
            this.overlay.update(this.rect.normalize());
            this.overlay.drawHTML(this.viewer.drawer.container, this.viewer.viewport);
        }
        return this;
    },

    undraw: function () {
        this.overlay.destroy();
        this.rect = null;
        return this;
    },

    confirm: function () {
        if (this.rect) {
            var result = this.rect.normalize();
            if (this.returnPixelCoordinates) {
                var real = this.viewer.viewport.viewportToImageRectangle(result);
                real = OpenSeadragon.SelectionRect.fromRect(real).round();
                real.rotation = result.rotation;
                result = real;
            }
            this.viewer.raiseEvent('selection', result);
            this.undraw();
        }
        return this;
    },

    cancel: function () {
        /*
         * These two lines have been added to fix a issue with mobile where the selection is just a pinpoint after the first drag
         * For some reason disabling then re-enabling the tracking fixes this issue.
         */
        this.outerTracker.setTracking(false);
        this.outerTracker.setTracking(true);
        this.viewer.raiseEvent('selection_cancel', false);
        return this.undraw();
    },
});

function onOutsideDrag(e) {
    // Disable move when makeing new selection
    this.viewer.setMouseNavEnabled(false);
    var delta = this.viewer.viewport.deltaPointsFromPixels(e.delta, true);
    var end = this.viewer.viewport.pointFromPixel(e.position, true);
    var start = new OpenSeadragon.Point(end.x - delta.x, end.y - delta.y);
    if (!this.rect) {
        if (this.restrictToImage) {
            if (!pointIsInImage(this, start)) {
                return;
            }
            restrictVector(delta, end);
        }
        if (this.startRotated) {
            this.rotatedStartPoint = start;
            this.rect = getPrerotatedRect(start, end, this.startRotatedHeight);
        } else {
            this.rect = new OpenSeadragon.SelectionRect(start.x, start.y, delta.x, delta.y);
        }
        this.rectDone = false;
    } else {
        var oldRect;
        if (this.restrictToImage) {
            oldRect = this.rect.clone();
        }
        if (this.rectDone) {
            // All rotation as needed.
            if (this.allowRotation) {
                var angle1 = this.rect.getAngleFromCenter(start);
                var angle2 = this.rect.getAngleFromCenter(end);
                this.rect.rotation = (this.rect.rotation + angle1 - angle2) % Math.PI;
            }
        } else {
            if (this.startRotated) {
                this.rect = getPrerotatedRect(this.rotatedStartPoint, end, this.startRotatedHeight);
            } else {
                this.rect.width += delta.x;
                this.rect.height += delta.y;
            }
        }
        var bounds = this.viewer.world.getHomeBounds();
        if (this.restrictToImage && !this.rect.fitsIn(new OpenSeadragon.Rect(0, 0, bounds.width, bounds.height))) {
            this.rect = oldRect;
        }
    }
    this.draw();
}

function onOutsideDragEnd() {
    // Resizing a selection will function
    // when drawn any direction
    if (this.rect.width < 0) {
        this.rect.x += this.rect.width;
        this.rect.width = Math.abs(this.rect.width);
    }
    if (this.rect.height < 0) {
        this.rect.y += this.rect.height;
        this.rect.height = Math.abs(this.rect.height);
    }

    // Eable move after new selection is done
    this.viewer.setMouseNavEnabled(true);
    this.rectDone = true;
}

function onClick() {
    this.viewer.canvas.focus();
}

function onInsideDrag(e) {
    OpenSeadragon.addClass(this.element, 'dragging');
    var delta = this.viewer.viewport.deltaPointsFromPixels(e.delta, true);
    this.rect.x += delta.x;
    this.rect.y += delta.y;
    var bounds = this.viewer.world.getHomeBounds();
    if (this.restrictToImage && !this.rect.fitsIn(new OpenSeadragon.Rect(0, 0, bounds.width, bounds.height))) {
        this.rect.x -= delta.x;
        this.rect.y -= delta.y;
    }
    this.draw();
}

function onInsideDragEnd() {
    OpenSeadragon.removeClass(this.element, 'dragging');
}

function onBorderDrag(border, e) {
    var delta = e.delta;
    var rotation = this.rect.getDegreeRotation();
    var center;
    var oldRect = this.restrictToImage ? this.rect.clone() : null;
    if (rotation !== 0) {
        // adjust vector
        delta = delta.rotate(-1 * rotation, new OpenSeadragon.Point(0, 0));
        center = this.rect.getCenter();
    }
    delta = this.viewer.viewport.deltaPointsFromPixels(delta, true);
    switch (border) {
        case 0:
            this.rect.y += delta.y;
            this.rect.height -= delta.y;
            break;
        case 1:
            this.rect.width += delta.x;
            break;
        case 2:
            this.rect.height += delta.y;
            break;
        case 3:
            this.rect.x += delta.x;
            this.rect.width -= delta.x;
            break;
        case 0.5:
            this.rect.y += delta.y;
            this.rect.height -= delta.y;
            this.rect.x += delta.x;
            this.rect.width -= delta.x;
            break;
        case 1.5:
            this.rect.y += delta.y;
            this.rect.height -= delta.y;
            this.rect.width += delta.x;
            break;
        case 2.5:
            this.rect.width += delta.x;
            this.rect.height += delta.y;
            break;
        case 3.5:
            this.rect.height += delta.y;
            this.rect.x += delta.x;
            this.rect.width -= delta.x;
            break;
        default:
            break;
    }
    if (rotation !== 0) {
        // calc center deviation
        var newCenter = this.rect.getCenter();
        // rotate new center around old
        var target = newCenter.rotate(rotation, center);
        // adjust new center
        delta = target.minus(newCenter);
        this.rect.x += delta.x;
        this.rect.y += delta.y;
    }
    var bounds = this.viewer.world.getHomeBounds();
    if (this.restrictToImage && !this.rect.fitsIn(new OpenSeadragon.Rect(0, 0, bounds.width, bounds.height))) {
        this.rect = oldRect;
    }
    this.draw();
}

// After you have completed dragging, ensure the top left of the selection
// box is still the top left corner of the box
function onBorderDragEnd() {
    if (this.rect.width < 0) {
        this.rect.x += this.rect.width;
        this.rect.width = Math.abs(this.rect.width);
    }
    if (this.rect.height < 0) {
        this.rect.y += this.rect.height;
        this.rect.height = Math.abs(this.rect.height);
    }
}

function onKeyPress(e) {
    var key = e.keyCode ? e.keyCode : e.charCode;
    if (key === 13) {
        this.confirm();
    } else if (String.fromCharCode(key) === this.keyboardShortcut) {
        this.toggleState();
    }
}

function getPrerotatedRect(start, end, height) {
    if (start.x > end.x) {
        // always draw left to right
        var x = start;
        start = end;
        end = x;
    }
    var delta = end.minus(start);
    var dist = start.distanceTo(end);
    var angle = -1 * Math.atan2(delta.x, delta.y) + (Math.PI / 2);
    var center = new OpenSeadragon.Point(
        delta.x / 2 + start.x,
        delta.y / 2 + start.y
    );
    var rect = new OpenSeadragon.SelectionRect(
        center.x - (dist / 2),
        center.y - (height / 2),
        dist,
        height,
        angle
    );
    var heightModDelta = new OpenSeadragon.Point(0, height);
    heightModDelta = heightModDelta.rotate(rect.getDegreeRotation(), new OpenSeadragon.Point(0, 0));
    rect.x += heightModDelta.x / 2;
    rect.y += heightModDelta.y / 2;
    return rect;
}

function pointIsInImage(self, point) {
    var bounds = self.viewer.world.getHomeBounds();
    return point.x >= 0 && point.x <= bounds.width && point.y >= 0 && point.y <= bounds.height;
}

function restrictVector(delta, end) {
    var start;
    for (var prop in { x: 0, y: 0 }) {
        start = end[prop] - delta[prop];
        if (start < 1 && start > 0) {
            if (end[prop] > 1) {
                delta[prop] -= end[prop] - 1;
                end[prop] = 1;
            } else if (end[prop] < 0) {
                delta[prop] -= end[prop];
                end[prop] = 0;
            }
        }
    }
}





// ============================================================================
// https://github.com/picturae/openseadragonselection/blob/master/src/selectionrect.js
/**
 * @class SelectionRect
 * @classdesc A display rectangle is very similar to {@link OpenSeadragon.Rect} but adds rotation
 * around the center point
 *
 * @memberof OpenSeadragon
 * @extends OpenSeadragon.Rect
 * @param {Number} x The vector component 'x'.
 * @param {Number} y The vector component 'y'.
 * @param {Number} width The vector component 'height'.
 * @param {Number} height The vector component 'width'.
 * @param {Number} rotation The rotation in radians
 */
OpenSeadragon.SelectionRect = function (x, y, width, height, rotation) {
    OpenSeadragon.Rect.apply(this, [x, y, width, height]);

    /**
     * The rotation in radians
     * @member {Number} rotation
     * @memberof OpenSeadragon.SelectionRect#
     */
    this.rotation = rotation || 0;
};

OpenSeadragon.SelectionRect.fromRect = function (rect) {
    return new OpenSeadragon.SelectionRect(
        rect.x,
        rect.y,
        rect.width,
        rect.height
    );
};

OpenSeadragon.SelectionRect.prototype = OpenSeadragon.extend(Object.create(OpenSeadragon.Rect.prototype), {

    /**
     * @function
     * @returns {OpenSeadragon.Rect} a duplicate of this Rect
     */
    clone: function () {
        return new OpenSeadragon.SelectionRect(this.x, this.y, this.width, this.height, this.rotation);
    },

    /**
     * Determines if two Rectangles have equivalent components.
     * @function
     * @param {OpenSeadragon.Rect} rectangle The Rectangle to compare to.
     * @return {Boolean} 'true' if all components are equal, otherwise 'false'.
     */
    equals: function (other) {
        return OpenSeadragon.Rect.prototype.equals.apply(this, [other]) &&
            (this.rotation === other.rotation);
    },

    /**
     * Provides a string representation of the rectangle which is useful for
     * debugging.
     * @function
     * @returns {String} A string representation of the rectangle.
     */
    toString: function () {
        return '[' +
            (Math.round(this.x * 100) / 100) + ',' +
            (Math.round(this.y * 100) / 100) + ',' +
            (Math.round(this.width * 100) / 100) + 'x' +
            (Math.round(this.height * 100) / 100) + '@' +
            (Math.round(this.rotation * 100) / 100) +
            ']';
    },

    swapWidthHeight: function () {
        var swapped = this.clone();
        swapped.width = this.height;
        swapped.height = this.width;
        swapped.x += (this.width - this.height) / 2;
        swapped.y += (this.height - this.width) / 2;
        return swapped;
    },

    /**
     * @function
     * @returns {Number} The rotaion in degrees
     */
    getDegreeRotation: function () {
        return this.rotation * (180 / Math.PI);
    },

    /**
     * @function
     * @param {OpenSeadragon.Point} point
     * @returns {Number} The angle in radians
     */
    getAngleFromCenter: function (point) {
        var diff = point.minus(this.getCenter());
        return Math.atan2(diff.x, diff.y);
    },

    /**
     * Rounds pixel coordinates
     * @function
     * @returns {SelectionRect} The altered rect
     */
    round: function () {
        return new OpenSeadragon.SelectionRect(
            Math.round(this.x),
            Math.round(this.y),
            Math.round(this.width),
            Math.round(this.height),
            this.rotation
        );
    },

    /**
     * Fixes negative width/height, rotation larger than PI
     * @function
     * @returns {SelectionRect} The normalized rect
     */
    normalize: function () {
        var fixed = this.clone();
        if (fixed.width < 0) {
            fixed.x += fixed.width;
            fixed.width *= -1;
        }
        if (fixed.height < 0) {
            fixed.y += fixed.height;
            fixed.height *= -1;
        }
        fixed.rotation %= Math.PI;
        return fixed;
    },

    /**
     * @function
     * @param {OpenSeadragon.Rect} area
     * @returns {Boolean} Does this rect fit in a specified area
     */
    fitsIn: function (area) {
        var rect = this.normalize();
        var corners = [
            rect.getTopLeft(),
            rect.getTopRight(),
            rect.getBottomRight(),
            rect.getBottomLeft(),
        ];
        var center = rect.getCenter();
        var rotation = rect.getDegreeRotation();
        var areaEnd = area.getBottomRight();
        for (var i = 0; i < 4; i++) {
            corners[i] = corners[i].rotate(rotation, center);
            if (corners[i].x < area.x || corners[i].x > areaEnd.x ||
                corners[i].y < area.y || corners[i].y > areaEnd.y) {
                return false;
            }
        }
        return true;
    },

    /**
     * Reduces rotation to within [-45, 45] degrees by swapping width & height
     * @function
     * @returns {SelectionRect} The altered rect
     */
    reduceRotation: function () {
        var reduced;
        if (this.rotation < Math.PI / (-4)) {
            reduced = this.swapWidthHeight();
            reduced.rotation += Math.PI / 2;
        } else if (this.rotation > Math.PI / 4) {
            reduced = this.swapWidthHeight();
            reduced.rotation -= Math.PI / 2;
        } else {
            reduced = this.clone();
        }
        return reduced;
    },
});



// ============================================================================
// https://github.com/picturae/openseadragonselection/blob/master/src/selectionoverlay.js
/**
 * @class Overlay
 * @classdesc Provides a way to float an HTML element on top of the viewer element.
 *
 * @memberof OpenSeadragon
 * @param {Object} options
 * @param {Element} options.element
 * @param {OpenSeadragon.Point|OpenSeadragon.Rect|OpenSeadragon.SelectionRect} options.location - The
 * location of the overlay on the image. If a {@link OpenSeadragon.Point}
 * is specified, the overlay will keep a constant size independently of the
 * zoom. If a {@link OpenSeadragon.Rect} is specified, the overlay size will
 * be adjusted when the zoom changes.
 * @param {OpenSeadragon.OverlayPlacement} [options.placement=OpenSeadragon.OverlayPlacement.TOP_LEFT]
 * Relative position to the viewport.
 * Only used if location is a {@link OpenSeadragon.Point}.
 * @param {OpenSeadragon.Overlay.OnDrawCallback} [options.onDraw]
 * @param {Boolean} [options.checkResize=true] Set to false to avoid to
 * check the size of the overlay everytime it is drawn when using a
 * {@link OpenSeadragon.Point} as options.location. It will improve
 * performances but will cause a misalignment if the overlay size changes.
 */
OpenSeadragon.SelectionOverlay = function (element, location) {
    OpenSeadragon.Overlay.apply(this, arguments);

    // set the rotation in radians
    if (OpenSeadragon.isPlainObject(element)) {
        this.rotation = element.location.rotation || 0;
    } else {
        this.rotation = location.rotation || 0;
    }
};

OpenSeadragon.SelectionOverlay.prototype = OpenSeadragon.extend(Object.create(OpenSeadragon.Overlay.prototype), {

    /**
     * @function
     * @param {Element} container
     */
    drawHTML: function () {
        OpenSeadragon.Overlay.prototype.drawHTML.apply(this, arguments);
        this.style.transform = this.style.transform.replace(/ ?rotate\(.+rad\)/, '') +
            ' rotate(' + this.rotation + 'rad)';
    },

    /**
     * @function
     * @param {OpenSeadragon.Point|OpenSeadragon.Rect} location
     * @param {OpenSeadragon.OverlayPlacement} position
     */
    update: function (location) {
        OpenSeadragon.Overlay.prototype.update.apply(this, arguments);
        this.rotation = location.rotation || 0;
    }
});
