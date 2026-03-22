<?php
/**
 * Frontend widget loader.
 *
 * @package DiveeSdkWpPlugin
 */

defined( 'ABSPATH' ) || exit;

/**
 * Build article data passed into the widget.
 *
 * @param int $post_id Post ID.
 * @return array<string, string>
 */
function divee_sdk_wp_get_article_data( $post_id ) {
	$content = (string) get_post_field( 'post_content', $post_id );
	$content = apply_filters( 'the_content', $content ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Calling core WP filter, not registering a custom hook.
	$content = wp_strip_all_tags( $content, true );
	$content = preg_replace( '/\s+/', ' ', $content );
	$content = trim( (string) $content );

	$data = array(
		'title'   => wp_strip_all_tags( get_the_title( $post_id ), true ),
		'content' => function_exists( 'mb_substr' ) ? mb_substr( $content, 0, 5000 ) : substr( $content, 0, 5000 ),
		'url'     => (string) get_permalink( $post_id ),
	);

	// Enrich with WooCommerce product data when available.
	if ( 'product' === get_post_type( $post_id ) && function_exists( 'wc_get_product' ) ) {
		$product = wc_get_product( $post_id );
		if ( $product instanceof WC_Product ) {
			// Short description.
			$short_desc = wp_strip_all_tags( $product->get_short_description(), true );
			if ( $short_desc ) {
				$data['short_description'] = $short_desc;
			}

			// Pricing.
			$data['price']          = wp_strip_all_tags( $product->get_price_html(), true );
			$data['regular_price']  = (string) $product->get_regular_price();
			$data['sale_price']     = (string) $product->get_sale_price();
			$data['currency']       = get_woocommerce_currency();

			// Stock.
			$data['stock_status']   = $product->get_stock_status(); // 'instock', 'outofstock', 'onbackorder'
			$stock_qty              = $product->get_stock_quantity();
			if ( null !== $stock_qty ) {
				$data['stock_quantity'] = (string) $stock_qty;
			}

			// Identity.
			$sku = $product->get_sku();
			if ( $sku ) {
				$data['sku'] = $sku;
			}
			$data['product_type'] = $product->get_type(); // 'simple', 'variable', 'grouped', etc.

			// Categories.
			$categories = get_the_terms( $post_id, 'product_cat' );
			if ( is_array( $categories ) && ! empty( $categories ) ) {
				$data['categories'] = implode( ', ', wp_list_pluck( $categories, 'name' ) );
			}

			// Tags.
			$tags = get_the_terms( $post_id, 'product_tag' );
			if ( is_array( $tags ) && ! empty( $tags ) ) {
				$data['tags'] = implode( ', ', wp_list_pluck( $tags, 'name' ) );
			}

			// Attributes (size, color, material, etc.).
			$attributes = $product->get_attributes();
			if ( ! empty( $attributes ) ) {
				$attr_parts = array();
				foreach ( $attributes as $attribute ) {
					if ( ! ( $attribute instanceof WC_Product_Attribute ) ) {
						continue;
					}
					$attr_name   = wc_attribute_label( $attribute->get_name() );
					$attr_values = $attribute->get_terms();
					if ( is_array( $attr_values ) && ! empty( $attr_values ) ) {
						$attr_parts[] = $attr_name . ': ' . implode( ', ', wp_list_pluck( $attr_values, 'name' ) );
					} elseif ( ! empty( $attribute->get_options() ) ) {
						$attr_parts[] = $attr_name . ': ' . implode( ', ', array_map( 'sanitize_text_field', $attribute->get_options() ) );
					}
				}
				if ( ! empty( $attr_parts ) ) {
					$data['attributes'] = implode( ' | ', $attr_parts );
				}
			}

			// Weight & dimensions.
			if ( $product->has_weight() ) {
				$data['weight'] = $product->get_weight() . ' ' . get_option( 'woocommerce_weight_unit' );
			}
			if ( $product->has_dimensions() ) {
				$data['dimensions'] = wc_format_dimensions( $product->get_dimensions( false ) );
			}

			// Shipping class.
			$shipping_class = $product->get_shipping_class();
			if ( $shipping_class ) {
				$data['shipping_class'] = $shipping_class;
			}

			// Terms & conditions page content (if set in WooCommerce settings).
			$tc_page_id = (int) get_option( 'woocommerce_terms_page_id' );
			if ( $tc_page_id ) {
				$tc_content = get_post_field( 'post_content', $tc_page_id );
				$tc_content = wp_strip_all_tags( $tc_content, true );
				$tc_content = preg_replace( '/\s+/', ' ', $tc_content );
				$tc_content = trim( $tc_content );
				if ( $tc_content ) {
					$data['terms_and_conditions'] = function_exists( 'mb_substr' ) ? mb_substr( $tc_content, 0, 3000 ) : substr( $tc_content, 0, 3000 );
				}
			}
		}
	}

	return $data;
}

/**
 * Return the shortcode mount element ID for a post.
 *
 * @param int $post_id Post ID.
 * @return string
 */
function divee_sdk_wp_get_shortcode_mount_id( $post_id ) {
	return 'divee-widget-mount-' . (int) $post_id;
}

/**
 * Render shortcode mount point used for manual placement.
 *
 * @param array<string, mixed> $atts Shortcode attributes.
 * @return string
 */
function divee_sdk_wp_render_shortcode_mount( $atts ) {
	if ( ! is_singular() ) {
		return '';
	}

	$post_id = divee_sdk_wp_get_current_post_id();
	if ( ! $post_id || ! divee_sdk_wp_should_display_widget() ) {
		return '';
	}

	$mount_id = divee_sdk_wp_get_shortcode_mount_id( $post_id );

	return '<div id="' . esc_attr( $mount_id ) . '" class="divee-widget-mount"></div>';
}

/**
 * Build inline JS that relocates the widget based on placement mode.
 *
 * @param string $mode    Placement mode.
 * @param int    $post_id Post ID.
 * @return string
 */
function divee_sdk_wp_get_placement_script( $mode, $post_id ) {
	$mount_id = divee_sdk_wp_get_shortcode_mount_id( $post_id );

	$config = array(
		'mode'    => $mode,
		'mountId' => $mount_id,
	);

	return '(function(){' .
		'var cfg=' . wp_json_encode( $config ) . ';' .
		'if(!cfg||cfg.mode==="auto_bottom"){return;}' .
		'function findTarget(){' .
			'if(cfg.mode==="shortcode"){return document.getElementById(cfg.mountId);}' .
			'return document.querySelector(".entry-content, .post-content, article, [role=\"article\"], main");' .
		'}' .
		'function placeWidget(){' .
			'var widget=document.querySelector(".divee-widget");' .
			'var target=findTarget();' .
			'if(!widget||!target){return false;}' .
			'if(cfg.mode==="auto_top"){target.prepend(widget);return true;}' .
			'if(cfg.mode==="shortcode"){target.appendChild(widget);return true;}' .
			'return false;' .
		'}' .
		'if(placeWidget()){return;}' .
		'var observer=new MutationObserver(function(){if(placeWidget()){observer.disconnect();}});' .
		'observer.observe(document.documentElement,{childList:true,subtree:true});' .
		'setTimeout(function(){observer.disconnect();},12000);' .
	'})();';
}

/**
 * Render the Divee SDK bootstrap directly in wp_head.
 */
function divee_sdk_wp_render_widget_script() {
	if ( ! divee_sdk_wp_should_display_widget() ) {
		return;
	}

	$post_id = divee_sdk_wp_get_current_post_id();
	$project_id = divee_sdk_wp_get_project_id();
	$placement_mode = divee_sdk_wp_get_placement_mode();

	if ( ! $post_id || '' === $project_id ) {
		return;
	}

	$article_data = divee_sdk_wp_get_article_data( $post_id );
	$placement_script = divee_sdk_wp_get_placement_script( $placement_mode, $post_id );
	$script_url = 'https://srv.divee.ai/storage/v1/object/public/sdk/divee.sdk.latest.js';
	?>
	<script>
		window.diveeArticle = <?php echo wp_json_encode( $article_data ); ?>;
		<?php echo $placement_script; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
	</script>
	<script
		src="<?php echo esc_url( $script_url ); ?>"
		data-project-id="<?php echo esc_attr( $project_id ); ?>"
		defer
	></script>
	<?php
}
