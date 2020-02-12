/* eslint-disable */
// https://github.com/picturae/OpenSeadragonImageFilters/blob/master/src/imagefilters.js
import { debounce } from "lodash"
import { Classes } from "@blueprintjs/core";

var OpenSeadragon = require('openseadragon')

require('./filtering')

//should disable caman cache to prevent memory leak
// var caman = Caman;
// caman.Store.put = function () {
// };

// We sync the image filters of all viewers with the same sync_key
export var synced_filters = {}

export const unregister_filter_sync = viewer => {
  Object.entries(synced_filters).forEach( ([sync_key, {viewers}]) => {
    viewers = viewers.filter(v => v.id !== viewer.id)
  })
}

const updateFilters = (sync_key, single_viewer) => {
    // console.log(synced_filters[sync_key]);
    const { viewers, filters } = synced_filters[sync_key];
    const sync = filters.every(f => f.sync);
    const _viewers = !!single_viewer ? [single_viewer] : viewers;
    _viewers.forEach(viewer => {
        const processors = filters.map(f => f.make_processor(viewer, f.value));
        // filters.forEach(f => console.log(f.name, f.value))
        viewer.setFilterOptions({
            filters: {
                processors,
            },
            loadMode: sync ? 'sync' : 'async',
        });
    })
}


const default_filters = [
    {
        name: 'Brightness',
        min: -255,
        max: 255,
        value: 1,
        defaultValue: 0,
        make_processor: (viewer, value) => {
            // if (this.callback !== null) {
            //     this.callback(value);
            // }
            return OpenSeadragon.Filters.BRIGHTNESS(value);
        },
        sync: true,
        // callback: null,
    },
    {
        name: 'Contrast',
        min: 0.1,
        max: 7,
        value: 1,
        defaultValue: 1,
        step: 0.1,
        make_processor: (viewer, value) => {
            // if (this.callback !== null) {
            //     this.callback(value);
            // }
            return OpenSeadragon.Filters.CONTRAST(value);
        },
        sync: true,
        // callback: null,
    },
    {
        name: 'Gamma',
        min: 0.05,
        max: 5,
        value: 1,
        defaultValue: 1,
        step: 0.05,
        make_processor: (viewer, value) => {
            // if (this.callback !== null) {
            //     this.callback(value);
            // }
            return OpenSeadragon.Filters.GAMMA(value);
        },
        sync: true,
        // callback: null,
    }
]


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
 */
OpenSeadragon.ImagefilterTools = function (options) {
    OpenSeadragon.extend(true, this, {
        // internal state properties
        viewer: null,
        sync_key: null,
        buttonActiveImg: false,

        // options
        showControl: true, // show button or not
        startOpen: false,  // start viewer with ImageFilterTools open
        prefixUrl: null,   // alternative location of images
        toolsLeft: null,   // int for absolute positioning
        toolsTop: null,    // int for absolute positioning
        toolsWidth: 180,   // int width in pixels
        toolsHeight: 150,  // int height in pixels
        popUpClass: null,  // override standard styling, NB. you need to style everything
        navImages: { // images for the buttons
            imagetools: {
                REST: 'imagetools_rest.png',
                GROUP: 'imagetools_grouphover.png',
                HOVER: 'imagetools_hover.png',
                DOWN: 'imagetools_pressed.png'
            }
        },
        //element: null,
        toggleButton: null
    }, options);

    const { sync_key, viewer } = this;
    if (synced_filters[sync_key] === undefined) {
      synced_filters[sync_key] = {
        viewers: [viewer],
        filters: default_filters,
        never_applied: true,
        // When the user moves a viewer, it leads the others whose events we ignore.
        leading: null, // viewer.id | null | "reset"
      }
    } else {
      if (synced_filters[sync_key].viewers.every(v => v.id !== viewer.id))
        synced_filters[sync_key].viewers.push(viewer)
    }

    this.viewer.addHandler('open', function () {
        this.createPopupDiv();
        this.updateFilters(sync_key);
    }.bind(this));

    if (this.startOpen) {
        this.viewer.addHandler('open', function () {
            this.openTools();
        }.bind(this));
    }


    OpenSeadragon.extend(true, this.navImages, this.viewer.navImages);
    var prefix = this.prefixUrl || this.viewer.prefixUrl || '';
    var useGroup = this.viewer.buttons && this.viewer.buttons.buttons;
    if (this.showControl) {
        this.toggleButton = new OpenSeadragon.Button({
            element: this.toggleButton ? OpenSeadragon.getElement(this.toggleButton) : null,
            clickTimeThreshold: this.viewer.clickTimeThreshold,
            clickDistThreshold: this.viewer.clickDistThreshold,
            tooltip: 'Image Tools',
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

    this.viewer.addOnceHandler('update-viewport', () => this.updateFilters(sync_key, this.viewer), {}, 1);
};

OpenSeadragon.extend(OpenSeadragon.ImagefilterTools.prototype, OpenSeadragon.ControlDock.prototype, /** @lends OpenSeadragon.ImagefilterTools.prototype */{

    /*
     Add popup div to viewer, and add range input elements per filter
     */
    createPopupDiv: function () {
        //check if tools popup exists and if not create based on filters
        var popup = OpenSeadragon.getElement(`osd-imagetools-${this.viewer.id}`);
        if (!popup) {
            //alway render toolpopup center LEFT if nothing is provided
            var width = this.toolsWidth;
            var height = this.toolsHeight;

            var v = OpenSeadragon.getElement(this.viewer.id);
            var viewerPosition = v.getBoundingClientRect();

            var popupTop = this.toolsTop || (viewerPosition.height / 2) - (height / 2);
            var popupLeft = this.toolsLeft || 10;

            popup = document.createElement('div');
            popup.id = `osd-imagetools-${this.viewer.id}`;
            if (this.popUpClass) {
                popup.className = `${this.popUpClass}`;
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
            synced_filters[this.sync_key].filters.map(filter => {
                var filterElement = document.createElement('input');
                filterElement.type = 'range';
                filterElement.min = filter.min;
                filterElement.max = filter.max;
                filterElement.step = filter.step || 1;
                filterElement.value = filter.value || 0;
                filterElement.id = `osd-filter-${filter.name}-${this.viewer.id}`;

                // add event handlers to slider
                this.onRangeChange(filterElement, filter);
                // add to tools popup with label
                var label = document.createElement('label');
                label.innerHTML = filter.name;
                // label.style.margin = '0';

                popup.appendChild(label);
                popup.appendChild(filterElement);
            });

            // Add Reset button
            var resetButton = document.createElement('button');
            resetButton.className = Classes.BUTTON;
            resetButton.innerHTML = 'Reset';
            resetButton.style.margin = '5px';
            // resetButton.style.display = 'block';
            resetButton.addEventListener('click', () => {
                this.resetFilters();
            }, { passive: true });
            popup.appendChild(resetButton);
        }
        return popup
    },

    /**
     * Open the tools popup
     */
    openTools: function () {
        var popup = OpenSeadragon.getElement(`osd-imagetools-${this.viewer.id}`) || this.createPopupDiv();
        toggleVisiblity(popup);
    },

    /**
     * Update filters via debounce so input events don't fire to soon after each other
     */
    updateFilters: debounce(updateFilters, 50),

    /**
     * Resets filters by setting range inputs to default value
     */
    resetFilters: function () {
        const { filters, viewers } = synced_filters[this.sync_key];
        synced_filters[this.sync_key].leading = 'reset'
        filters.map(filter => {
            filter.value = filter.defaultValue;
            viewers.map(viewer => {
              const filterInput = OpenSeadragon.getElement(`osd-filter-${filter.name}-${viewer.id}`);
              if (filterInput)
                filterInput.value = filter.value
            })
            // console.log(`[reset] ${filter.name} => ${filter.value}`)
        });
        this.updateFilters(this.sync_key);
        synced_filters[this.sync_key].leading = null;
    },

    onRangeChange: function (input_element, filter) {
        const update = sync_key => {
            const { filters, viewers, leading } = synced_filters[sync_key];
            if (!!leading && (leading !== this.viewer.id))
                return
            synced_filters[sync_key].leading = this.viewer.id;
            filter.value = getElementValueAsFloat(input_element);
            // console.log(`[set] ${filter.name} => ${filter.value}`)
            viewers.map(viewer => {
                const filterInput = OpenSeadragon.getElement(`osd-filter-${filter.name}-${viewer.id}`);
                if (filterInput)
                    filterInput.value = filter.value;
            })
            this.updateFilters(sync_key);
            synced_filters[sync_key].leading = null;
        }

        input_element.addEventListener('input', () => {
            // console.log(`[onRangeChange] (input)`)
            filter.never_applied = false;
            update(this.sync_key)
        }, { passive: true });
        //needed for older IE should we support it?
        input_element.addEventListener('change', () => {
            // console.log(`[onRangeChange] (change)`)
            if (filter.never_applied) {
                filter.never_applied = false;
                // console.log(`[onRangeChange] (change) ${filter.name} => ${value}`)
                update(this.sync_key)
            }
        }, { passive: true });
    }
});

function getElementValueAsFloat(element) {
    return parseFloat(OpenSeadragon.getElement(element).value);
}

function toggleVisiblity(element) {
    var isShown = (window.getComputedStyle ? getComputedStyle(element, null) : element.currentStyle).display;
    if (isShown !== 'none') {
        element.style.display = 'none';
    } else {
        element.style.display = 'block';
    }
}
