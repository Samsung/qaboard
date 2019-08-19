/* eslint-disable */
// https://github.com/picturae/OpenSeadragonImageFilters/blob/master/src/imagefilters.js
import { debounce } from "lodash"
var OpenSeadragon = require('openseadragon')

require('./filtering')

//should disable caman cache to prevent memory leak
// var caman = Caman;
// caman.Store.put = function () {
// };

OpenSeadragon.Viewer.prototype.imagefilters = function (options) {
    if (!this.imageFilterInstance || options) {
        options = options || {};
        options.viewer = this;

        this.imageFilterInstance = new OpenSeadragon.ImagefilterTools(options);
    }
    return this.imageFilterInstance;
};

/**
 * @class ImagefilterTools
 * @classdesc Provides functionality for displaying imagefilters as rangesliders
 * @memberof OpenSeadragon
 * @param {Object} options
 */
OpenSeadragon.ImagefilterTools = function (options) {
    OpenSeadragon.extend(true, this, {
        // internal state properties
        viewer: null,
        viewer_ref: null,
        buttonActiveImg: false,

        // options
        showControl: true, //show button or not
        startOpen: false, //start viewer with ImageFilterTools open
        prefixUrl: null, //alternative location of images
        toolsLeft: null, //int for absolute positioning
        toolsTop: null, //int for absolute positioning
        toolsWidth: 180, //int width in pixels
        toolsHeight: 150, //int height in pixels
        popUpClass: null, //override standard styling, NB. you need to style everything
        navImages: { //images to use
            imagetools: {
                REST: 'imagetools_rest.png',
                GROUP: 'imagetools_grouphover.png',
                HOVER: 'imagetools_hover.png',
                DOWN: 'imagetools_pressed.png'
            }
        },
        filters: [ //add filters here
            {
                filterName: 'brightness',
                min: -255,
                max: 255,
                callback: null,
                processor: function () {
                    var setTo = getElementValueAsFloat('osd-filter-brightness');
                    if (this.callback !== null) {
                        this.callback(setTo);
                    }
                    return OpenSeadragon.Filters.BRIGHTNESS(setTo);
                }
            },
            {
                filterName: 'contrast',
                min: 0,
                max: 5,
                value: 1,
                defaultValue: 1,
                step: 0.1,
                callback: null,
                processor: function () {
                    var setTo = getElementValueAsFloat('osd-filter-contrast');
                    if (this.callback !== null) {
                        this.callback(setTo);
                    }
                    return OpenSeadragon.Filters.CONTRAST(setTo);
                }
            }
            //Left below in code as example
            // saturation requires caman and caman requires reload of tiles. (see sync option)
            // {
            //     filterName: 'saturation',
            //     min: -100,
            //     max: 100,
            //     sync: false,
            //     processor: function() {
            //         var setTo = getElementValueAsFloat('osd-filter-saturation');
            //         this.current = setTo;
            //         return function (context, callback) {
            //             caman(context.canvas, function () {
            //                 this.saturation(setTo);
            //                 this.render(callback);
            //             });
            //             this.current = setTo;
            //         };
            //     }
            // },
            // {
            //     filterName: 'hue',
            //     min: 0,
            //     max: 100,
            //     sync: false,
            //     processor: function() {
            //         var setTo = getElementValueAsFloat('osd-filter-hue');
            //         return function (context, callback) {
            //             caman(context.canvas, function () {
            //                 this.hue(setTo);
            //                 this.render(callback);
            //             });
            //         };
            //     }
            // }
        ],
        //element: null,
        toggleButton: null
    }, options);

    OpenSeadragon.extend(true, this.navImages, this.viewer.navImages);

    var prefix = this.prefixUrl || this.viewer.prefixUrl || '';
    var useGroup = this.viewer.buttons && this.viewer.buttons.buttons;

    if (this.showControl) {
        this.toggleButton = new OpenSeadragon.Button({
            element: this.toggleButton ? OpenSeadragon.getElement(this.toggleButton) : null,
            clickTimeThreshold: this.viewer.clickTimeThreshold,
            clickDistThreshold: this.viewer.clickDistThreshold,
            tooltip: 'Image tools',
            srcRest: prefix + this.navImages.imagetools.REST,
            srcGroup: prefix + this.navImages.imagetools.GROUP,
            srcHover: prefix + this.navImages.imagetools.HOVER,
            srcDown: prefix + this.navImages.imagetools.DOWN,
            onRelease: this.openTools.bind(this)
        });

        if (useGroup) {
            this.viewer.buttons.buttons.push(this.toggleButton);
            this.viewer.buttons.element.appendChild(this.toggleButton.element);
        }
        if (this.toggleButton.imgDown) {
            this.buttonActiveImg = this.toggleButton.imgDown.cloneNode(true);
            this.toggleButton.element.appendChild(this.buttonActiveImg);
        }
    }

    this.viewer.addHandler('open', function () {
        this.createPopupDiv();
        this.updateFilters();
    }.bind(this));

    if (this.startOpen) {
        this.viewer.addHandler('open', function () {
            this.openTools();
        }.bind(this));
    }
};

OpenSeadragon.extend(OpenSeadragon.ImagefilterTools.prototype, OpenSeadragon.ControlDock.prototype, /** @lends OpenSeadragon.ImagefilterTools.prototype */{

    /*
     Add popup div to viewer, and add range input elements per filter
     */
    createPopupDiv: function () {
        //check if tools popup exists and if not create based on filters
        var popup = OpenSeadragon.getElement('osd-imagetools');
        if (!popup) {

            //alway render toolpopup center LEFT if nothing is provided
            var width = this.toolsWidth;
            var height = this.toolsHeight;

            var v = OpenSeadragon.getElement(this.viewer.id);
            var viewerPosition = v.getBoundingClientRect();

            var popupTop = this.toolsTop || (viewerPosition.height / 2) - (height / 2);
            var popupLeft = this.toolsLeft || 10;

            popup = document.createElement('div');
            popup.id = 'osd-imagetools';
            if (this.popUpClass) {
                popup.class = this.popUpClass;
            } else {
                popup.style.display = 'none';
                popup.style.textAlign = 'center';
                popup.style.position = 'absolute';
                popup.style.border = '1px solid black';
                popup.style.backgroundColor = 'white';
                popup.style.width = width + 'px';
                popup.style.height = height + 'px';
                popup.style.top = popupTop + 'px';
                popup.style.left = popupLeft + 'px';
            }

            //add to controlls, needed for fullscreen
            this.viewer.addControl(popup, {});
            popup.style.display = 'none'; //add Controll sets display:block

            //add range input for all filters
            this.filters.map(function (filter) {
                var filterElement = document.createElement('input');
                filterElement.type = 'range';
                filterElement.min = filter.min;
                filterElement.max = filter.max;
                filterElement.step = filter.step || 1;
                filterElement.value = filter.value || 0;
                filterElement.id = 'osd-filter-' + filter.filterName;

                //add event to slider
                this.onRangeChange(filterElement);
                //add to tools popup with label
                var label = document.createElement('p');
                label.style.margin = '0';
                label.innerHTML = `Tool. ${filter.filterName}`;

                popup.appendChild(label);
                popup.appendChild(filterElement);
            }.bind(this));

            //add reset button
            var resetButton = document.createElement('button');
            resetButton.innerHTML = 'reset';
            resetButton.style.display = 'block';
            resetButton.style.margin = '0 auto';
            resetButton.style.padding = '2px';

            //add functionality to reset button
            resetButton.addEventListener('click', function () {
                this.resetFilters();
            }.bind(this), { passive: true });
            popup.appendChild(resetButton);
        }
    },

    /**
     * Open the tools popup
     */
    openTools: function () {
        var popup = OpenSeadragon.getElement('osd-imagetools');
        if (!popup) {
            this.createPopupDiv();
            this.updateFilters();
            popup = OpenSeadragon.getElement('osd-imagetools');
        }
        toggleVisablity(popup);
    },

    /**
     * Update filters via debounce so input events don't fire to soon after each other
     */
    updateFilters: debounce(updateFilters, 50),

    /**
     * Resets filters by setting range inputs to default value
     */
    resetFilters: function () {
        this.filters.map(function (filter) {
            var filterInput = OpenSeadragon.getElement('osd-filter-' + filter.filterName);
            filterInput.value = filter.defaultValue || 0;
        });
        this.updateFilters();
    },

    /**
     * Add update event to element
     * @param rangeInputElmt
     * @param listener
     */
    onRangeChange: function (rangeInputElmt) {
        var inputEvtHasNeverFired = true;
        rangeInputElmt.addEventListener('input', function () {
            inputEvtHasNeverFired = false;
            this.updateFilters();
        }.bind(this), { passive: true });
        //needed for older IE should we support it?
        rangeInputElmt.addEventListener('change', function () {
            if (inputEvtHasNeverFired) {
                this.updateFilters();
            }
        }.bind(this), { passive: true });
    }
});

/**
 * Toggle element display property
 * @param element
 */
function toggleVisablity(element) {
    //var isShown = element.currentStyle ? element.currentStyle.display : getComputedStyle(element, null).display;
    var isShown = (window.getComputedStyle ? getComputedStyle(element, null) : element.currentStyle).display;
    if (isShown !== 'none') {
        element.style.display = 'none';
    } else {
        element.style.display = 'block';
    }
}

/**
 * get Element value as Float
 * @param element
 * @returns {Number}
 */
function getElementValueAsFloat(element) {
    return parseFloat(OpenSeadragon.getElement(element).value);
}

/**
 * Updates filters of viewers
 */
function updateFilters() {
    var filters = [];
    var sync = true;

    this.filters.map(function (filter) {
        filters.push(filter.processor());
        if (filter.sync === false) {
            sync = false;
        }
    });

    this.viewer.setFilterOptions({
        filters: {
            processors: filters
        },
        loadMode: sync ? 'sync' : 'async'
    });
    this.viewer_ref.setFilterOptions({
        filters: {
            processors: filters
        },
        loadMode: sync ? 'sync' : 'async'
    });
}
