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
	$content = apply_filters( 'the_content', $content );
	$content = wp_strip_all_tags( $content, true );
	$content = preg_replace( '/\s+/', ' ', $content );
	$content = trim( (string) $content );

	return array(
		'title'   => wp_strip_all_tags( get_the_title( $post_id ), true ),
		'content' => function_exists( 'mb_substr' ) ? mb_substr( $content, 0, 5000 ) : substr( $content, 0, 5000 ),
		'url'     => (string) get_permalink( $post_id ),
		'image'   => (string) get_the_post_thumbnail_url( $post_id, 'full' ),
	);
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
